// ==UserScript==
// @name         LETUS PMS · EDI 재고 자동 동기화
// @namespace    letus-pms
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/letus-junghoonhyun/letus-pms/main/tools/edi-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/letus-junghoonhyun/letus-pms/main/tools/edi-sync.user.js
// @description  EDI 로그인 후 메인 화면이 열리면, PMS에 없는 날짜부터 어제까지의 일별 재고를 조회해 PMS로 보냅니다.
// @match        http://edi.ajuprs.com/main_frame.do
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      supabase.co
// @connect      xtqblxitzzrjzeqniigp.supabase.co
// @run-at       document-idle
// ==/UserScript==
//
// 설치: Chrome/Edge 에 Tampermonkey 확장 설치 → 새 스크립트에 이 파일 내용 붙여넣기 → 저장.
// 첫 실행 때 "함수 주소", "anon 키", "토큰"을 한 번 묻습니다(브라우저에만 저장, 파일에는 남지 않음).
// 함수는 Verify JWT 를 켠 채로 두면 됩니다(anon 키가 통과용, 진짜 잠금은 토큰).
// 토큰은 Supabase 함수 비밀값 EDI_INGEST_TOKEN 과 같은 값입니다.

(function () {
  "use strict";
  const COLS = "STOC_DATE|DATE_NAME|DEMD_TYPE|ITEM_NAME|LAST_STOC|RD00_VOLM|RD01_VOLM|RD05_VOLM|RD08_VOLM|RD99_VOLM|MS00_VOLM|MSCF_VOLM|MSCT_VOLM|MSCX_VOLM|MSIN_VOLM|MSOT_VOLM|MD00_VOLM|MDCF_VOLM|MDCT_VOLM|MDCX_VOLM|MDIN_VOLM|MDOT_VOLM|RS00_VOLM|RS01_VOLM|RS05_VOLM|RS06_VOLM|RS99_VOLM|DEST_VOLM|THIS_STOC|CONT_STOC|BACK_STOC|CONF_STOC|SELF_VOLM|sStatus".split("|");
  const MCOLS = "sSeq|sStatus|sCheck|MOVE_CODE|DEMD_DATE|DATE_NAME|SHOT_NAME|DELV_POST_NAME|STOR_POST_NAME|SELF_CODE|INER_MOVE|MOVE_TYPE|MOVE_VOLM|ABS_MOVE_VOLM|CHNG_FLAG|CONF_FLAG|RETN_FLAG|BILL_NUMB|MOVE_DESC".split("|");
  const MOVE_CHUNK_DAYS = 7;  // 이동 내역은 하루 300건 안팎이라 7일씩 나눠 조회
  const CHUNK_DAYS = 40;      // 한 번에 조회할 최대 일수
  const START_DATE = "2026-09-26"; // 실제 데이터 사용 시작일(정산기간 26일 시작). 처음 받는 작업장은 여기서부터
  const CONCURRENCY = 3;      // 동시에 조회할 작업장 수 (EDI 서버 부담을 줄이려고 3개로 제한)
  const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1시간 안에 다시 열면 건너뜀
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 작은 상태창 ──
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:99999;background:#0f1424;color:#fff;font:12px/1.5 sans-serif;padding:10px 14px;border-radius:10px;max-width:320px;box-shadow:0 4px 14px rgba(0,0,0,.3)";
  const say = (t, keep) => { box.textContent = "LETUS PMS · " + t; if (!box.parentNode) document.body.appendChild(box); if (!keep) setTimeout(() => box.remove(), 8000); };

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const num = (v) => parseInt(v, 10) || 0;

  function call(action, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST", url: GM_getValue("fnUrl"),
        headers: { "Content-Type": "application/json", apikey: GM_getValue("anon"), Authorization: "Bearer " + GM_getValue("anon") },
        data: JSON.stringify({ token: GM_getValue("token"), action, ...payload }),
        timeout: 120000,
        onload: (r) => {
          let j = {}; try { j = JSON.parse(r.responseText); } catch (e) {}
          if (r.status === 200) return resolve(j);
          // 틀린 설정값은 지워서 다음 새로고침 때 입력창이 다시 뜨게 한다
          if (r.status === 404) { GM_setValue("fnUrl", ""); return reject(new Error("함수 주소가 틀렸어요. EDI를 새로고침하면 주소를 다시 물어봅니다")); }
          if (r.status === 401 && j.error === "unauthorized") { GM_setValue("token", ""); return reject(new Error("토큰이 틀렸어요. EDI를 새로고침하면 다시 물어봅니다")); }
          if (r.status === 401) { GM_setValue("anon", ""); return reject(new Error("anon 키가 틀렸어요. EDI를 새로고침하면 다시 물어봅니다")); }
          reject(new Error(j.error || "HTTP " + r.status));
        },
        onerror: () => reject(new Error("PMS 서버 연결 실패 — 저장된 주소: " + GM_getValue("fnUrl"))), ontimeout: () => reject(new Error("PMS 서버 응답 시간 초과")),
      });
    });
  }

  async function demdInfo() {
    const html = await (await fetch("/edi/stoc/STOC_CLNT_LIST.do", { credentials: "same-origin" })).text();
    // 작업장 코드는 HTML 속성이 아니라 페이지 스크립트의 $("#demdCode").val('P123456') 문장에 들어 있다
    const c = html.match(/\$\(\s*["']#demdCode["']\s*\)\.val\(\s*'([^']*)'\s*\)/);
    const n = html.match(/\$\(\s*["']#demdName["']\s*\)\.val\(\s*'([^']*)'\s*\)/);
    if (!c || !c[1]) throw new Error("EDI 작업장 코드를 못 찾았어요(로그인 상태 확인)");
    return { code: c[1], name: n ? n[1] : "" };
  }

  async function pull(demd, no, from, to) {
    const body = "S_SAVENAME=" + COLS.join("|") + "&title=조회기간&begnDate=" + from + "&enddDate=" + to +
      "&title=제품유형&itemCode=&title=작업장&demdCode=" + encodeURIComponent(demd.code) + "&demdName=" + encodeURIComponent(demd.name) +
      "&demdNumb=" + (no === 0 ? "" : no) + "&title=출고&"; // 0번 = 모든작업장 합계
    const res = await fetch("/edi/stoc/EDI_STOC_CLNT_LIST_NEW.do", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body, credentials: "same-origin" });
    const text = await res.text();
    const at = text.indexOf("<?xml");
    if (at < 0) throw new Error("EDI 응답이 비정상이에요(로그인 만료?)");
    const xml = new DOMParser().parseFromString(text.slice(at), "text/xml");
    const out = [];
    xml.querySelectorAll("TR").forEach((tr) => {
      const o = {};
      tr.querySelectorAll("TD").forEach((td, i) => { o[COLS[i]] = td.textContent; });
      if (!o.ITEM_NAME || !o.STOC_DATE) return; // 합계 행 제외
      out.push({
        stoc_date: o.STOC_DATE, workplace_no: no, item: o.ITEM_NAME,
        last_stoc: num(o.LAST_STOC), rental_in: num(o.RD00_VOLM), move_in: num(o.MS00_VOLM),
        move_out: num(o.MD00_VOLM), return_out: num(o.RS00_VOLM), this_stoc: num(o.THIS_STOC), raw: o,
      });
    });
    return out;
  }

  // 거래처 입출고 조회 화면의 사용자 ID(instEmpn): HTML 안에 값이 들어 있다
  async function instEmpn() {
    const html = await (await fetch("/edi/stoc/STOC_CLNT_STDE.do", { credentials: "same-origin" })).text();
    const m = html.match(/name=["']instEmpn["'][^>]*value=["']([^"']*)["']/) || html.match(/id=["']instEmpn["'][^>]*value=["']([^"']*)["']/);
    if (!m || !m[1]) throw new Error("EDI 사용자 ID(instEmpn)를 못 찾았어요");
    return m[1];
  }

  async function pullMoves(demd, inst, from, to) {
    const body = "S_SAVENAME=" + MCOLS.join("|") + "&demdCode=" + encodeURIComponent(demd.code) + "&instEmpn=" + encodeURIComponent(inst) +
      "&postCode=&demdName=&postName=&postNumb=&storTypeNm=&remvFlag=N&itemCode=&begnDate=" + from + "&enddDate=" + to +
      "&confFlag=&inerMove=1&demdNumb=&retnFlag=&"; // 작업장 비움 = 모든작업장
    let text = "";
    for (let t = 0; ; t++) {
      try {
        const res = await fetch("/edi/stoc/STOC_CLNT_STDE_SEARCH.do", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body, credentials: "same-origin" });
        text = await res.text();
        if (text.indexOf("<?xml") < 0) throw new Error("EDI 응답이 비정상이에요(로그인 만료?)");
        break;
      } catch (e) { if (/로그인 만료/.test(e.message) || t >= 2) throw e; await sleep(4000 * (t + 1)); }
    }
    const xml = new DOMParser().parseFromString(text.slice(text.indexOf("<?xml")), "text/xml");
    const out = [];
    xml.querySelectorAll("TR").forEach((tr) => {
      const o = {};
      tr.querySelectorAll("TD").forEach((td, i) => { o[MCOLS[i]] = td.textContent; });
      if (!o.MOVE_CODE || !o.DEMD_DATE) return;
      out.push({
        move_code: o.MOVE_CODE, move_date: o.DEMD_DATE, item: o.SHOT_NAME, from_name: o.DELV_POST_NAME, to_name: o.STOR_POST_NAME,
        move_type: o.MOVE_TYPE, iner: o.INER_MOVE, qty: num(o.MOVE_VOLM), chng: o.CHNG_FLAG, conf: o.CONF_FLAG, retn: o.RETN_FLAG,
        bill_no: o.BILL_NUMB, note: o.MOVE_DESC,
      });
    });
    return out;
  }

  async function run() {
    // 형식이 틀린 주소(오타 등)는 지우고 다시 입력받는다
    if (GM_getValue("fnUrl") && !/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/[\w-]+$/.test(GM_getValue("fnUrl"))) GM_setValue("fnUrl", "");
    if (!GM_getValue("fnUrl")) {
      const u = prompt("PMS 수신 함수 주소 (예: https://xxxx.supabase.co/functions/v1/edi-ingest)");
      if (!u) return;
      GM_setValue("fnUrl", u.trim());
    }
    if (!GM_getValue("anon")) {
      const a = prompt("Supabase anon public 키 (src/supabase.js 의 SUPABASE_ANON_KEY 와 같은 값. 공개돼도 되는 키)");
      if (!a) return;
      GM_setValue("anon", a.trim());
    }
    if (!GM_getValue("token")) {
      const t = prompt("수신 토큰 (Supabase 함수 비밀값 EDI_INGEST_TOKEN 과 같은 값)");
      if (!t) return;
      GM_setValue("token", t.trim());
    }
    if (Date.now() - (GM_getValue("lastRun2") || 0) < MIN_INTERVAL_MS) return;

    say("동기화 준비 중…", true);
    const demd = await demdInfo();
    const { workplaces } = await call("status", {});
    if (!workplaces || !workplaces.length) { say("동기화 대상 작업장이 없어요 (PMS에서 지정)"); return; }

    const yesterday = parse(fmt(addDays(new Date(), -1))); // 시각을 뺀 어제 날짜
    const st = { total: 0, done: 0, failed: 0, idle: 0, lastErr: "", abort: false };
    let todo = [];
    const label = () => `${st.done}/${todo.length}곳 · ${st.total}행` + (st.failed ? ` · 실패 ${st.failed}` : "");

    // ── 1) 건별 이동(거래처 입출고 조회): 모든작업장을 한 번에. 수정·소급 등록을 잡으려고 최근 3일은 다시 받는다 ──
    let mv = 0, mvErr = "";
    const movedNames = new Set(); // 이번에 받은 이동에 등장한 작업장(재고가 바뀌었을 수 있는 곳)
    try {
      const inst = await instEmpn();
      const { last_date } = await call("move_status", {});
      let from = last_date ? addDays(parse(last_date), -3) : parse(START_DATE);
      if (from < parse(START_DATE)) from = parse(START_DATE);
      let guard = 0;
      while (from <= yesterday && guard++ < 60) {
        const to = new Date(Math.min(addDays(from, MOVE_CHUNK_DAYS - 1), yesterday));
        say(`이동 내역 ${fmt(from)}~${fmt(to)} 조회 중…`, true);
        const rows = await pullMoves(demd, inst, fmt(from), fmt(to));
        rows.forEach((r) => { movedNames.add(r.from_name); movedNames.add(r.to_name); });
        if (rows.length) { await call("moves_upsert", { rows, note: fmt(from) + "~" + fmt(to) }); mv += rows.length; }
        from = addDays(to, 1);
      }
    } catch (e) {
      mvErr = e.message;
      if (/로그인 만료|토큰이|주소가|anon 키가/.test(e.message)) st.abort = true;
    }

    // ── 2) 재고: 못 받은 작업장 + 이동이 있었던 작업장(최근 3일 다시) + 전체 합계(0번) ──
    const refreshFrom = new Date(Math.max(addDays(yesterday, -3), parse(START_DATE)));
    const refresh = new Set(workplaces.filter((w) => w.no === 0 || movedNames.has(w.name)).map((w) => w.no));
    todo = st.abort ? [] : workplaces.filter((w) => !w.last_synced || parse(w.last_synced) < yesterday || refresh.has(w.no));
    let next = 0;
    async function worker() {
      while (!st.abort) {
        const w = todo[next++];
        if (!w) return;
        try {
          let from = w.last_synced ? addDays(parse(w.last_synced), 1) : parse(START_DATE);
          if (w.last_synced && refresh.has(w.no) && refreshFrom < from) from = refreshFrom;
          let guard = 0, any = false;
          while (from <= yesterday && guard++ < 10) {
            const to = new Date(Math.min(addDays(from, CHUNK_DAYS - 1), yesterday));
            say(`${w.name} ${fmt(from)}~${fmt(to)} 조회 중… (${label()})`, true);
            let rows;
            for (let t = 0; ; t++) { // 일시 오류는 최대 2번 재시도
              try { rows = await pull(demd, w.no, fmt(from), fmt(to)); break; }
              catch (e) { if (/로그인 만료/.test(e.message) || t >= 2) throw e; await sleep(4000 * (t + 1)); }
            }
            if (rows.length) { await call("upsert", { rows, note: "userscript " + w.name }); st.total += rows.length; any = true; }
            from = addDays(to, 1);
          }
          if (!any && !w.last_synced) { // 재고가 전혀 없는 작업장: 조회했다는 표시만 남겨 다음부터 건너뛴다
            const z = { stoc_date: fmt(yesterday), workplace_no: w.no, item: "-", last_stoc: 0, rental_in: 0, move_in: 0, move_out: 0, return_out: 0, this_stoc: 0, raw: null };
            await call("upsert", { rows: [z], note: "userscript(빈 작업장) " + w.name }); st.idle++;
          }
          st.done++;
        } catch (e) {
          st.failed++; st.lastErr = w.name + ": " + e.message;
          if (/로그인 만료|EDI 작업장 코드/.test(e.message)) st.abort = true; // EDI 세션이 끊기면 전체 중단(다음 접속 때 이어서)
          if (/토큰이|주소가|anon 키가/.test(e.message)) st.abort = true;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    GM_setValue("lastRun2", st.failed || mvErr ? 0 : Date.now()); // 실패가 있으면 다음 접속 때 바로 이어서 재시도
    const mvTxt = mvErr ? ` · 이동내역 실패: ${mvErr}` : ` · 이동 ${mv}건`;
    say(st.abort ? `중단됨 · ${label()} — ${st.lastErr || mvErr} (다시 접속하면 이어서 받아요)`
      : st.failed ? `완료 ${label()} · 마지막 오류 ${st.lastErr}${mvTxt}`
      : `동기화 완료 · 재고 ${st.done}곳 ${st.total}행${mvTxt} (어제까지)`, st.abort || st.failed || !!mvErr);
  }

  run().catch((e) => say("동기화 실패: " + e.message));
})();
