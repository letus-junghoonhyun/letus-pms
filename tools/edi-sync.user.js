// ==UserScript==
// @name         LETUS PMS · EDI 재고 자동 동기화
// @namespace    letus-pms
// @version      3.5
// @updateURL    https://raw.githubusercontent.com/letus-junghoonhyun/letus-pms/main/tools/edi-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/letus-junghoonhyun/letus-pms/main/tools/edi-sync.user.js
// @description  EDI 로그인 후 메인 화면이 열리면, 로그인한 계정(14C·18F / 일반유형 / 15A 전용 / 23E 전용)의 재고·이동을 어제까지 조회해 PMS로 보냅니다.
// @match        http://edi.ajuprs.com/main_frame.do
// @match        http://edi.ajuprs.com/edi/ware/WARE_MOVE_DETL.do*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
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
  const REFRESH_DAYS = 7;     // 소급 등록·정정을 반영하려고 최근 7일은 다시 받는다 (이동이 있던 작업장만)
  const MOVE_CHUNK_DAYS = 7;  // 이동 내역은 하루 300건 안팎이라 7일씩 나눠 조회
  const CHUNK_DAYS = 40;      // 한 번에 조회할 최대 일수
  const START_DATE = "2026-09-26"; // 실제 데이터 사용 시작일(정산기간 26일 시작). 처음 받는 작업장은 여기서부터
  const CONCURRENCY = 3;      // 동시에 조회할 작업장 수 (EDI 서버 부담을 줄이려고 3개로 제한)
  const MIN_INTERVAL_MS = 20 * 60 * 1000; // 같은 계정은 20분 안에 다시 열면 건너뜀(건너뛴다고 화면에 알려준다)
  const lastMap = () => { try { return JSON.parse(GM_getValue("lastRunMap") || "{}"); } catch (e) { return {}; } };
  const getLast = (acc) => lastMap()[acc] || 0;
  const setLast = (acc, v) => { const m = lastMap(); m[acc] = v; GM_setValue("lastRunMap", JSON.stringify(m)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 작은 상태창 ──
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:99999;background:#0f1424;color:#fff;font:12px/1.5 sans-serif;padding:10px 14px;border-radius:10px;max-width:320px;box-shadow:0 4px 14px rgba(0,0,0,.3)";
  let ACCOUNT = "", TAG = ""; // 로그인한 EDI 계정(작업장코드)과 표시 이름
  const say = (t, keep) => { box.textContent = "LETUS PMS · " + (TAG ? "[" + TAG + "] " : "") + t; if (!box.parentNode) document.body.appendChild(box); if (!keep) setTimeout(() => box.remove(), 8000); };

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
        data: JSON.stringify({ token: GM_getValue("token"), action, account: ACCOUNT || undefined, ...payload }),
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

  // 로그인한 계정에서 보이는 작업장 목록과 제품 목록 (EDI 재고조회 화면의 선택 목록)
  function readCombos() {
    return new Promise((resolve, reject) => {
      const f = document.createElement("iframe");
      f.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;visibility:hidden";
      f.src = "/edi/stoc/STOC_CLNT_LIST.do";
      document.body.appendChild(f);
      const t0 = Date.now();
      const tick = () => {
        try {
          const d = f.contentDocument, sel = d && d.getElementById("demdNumb"), it = d && d.getElementById("itemCode");
          if (sel && sel.options.length > 1 && it && it.options.length > 0) {
            const list = [...sel.options].filter((o) => o.value !== "").map((o) => ({ no: parseInt(o.value, 10), name: o.text.replace(/^\d+\./, "").trim() })).filter((w) => Number.isInteger(w.no));
            const items = [...it.options].filter((o) => o.value).map((o) => o.text.trim());
            f.remove(); return resolve({ list, items });
          }
        } catch (e) { /* 아직 로딩 중 */ }
        if (Date.now() - t0 > 40000) {
          // 작업장이 하나도 없는 계정(전체 합계만)이면 빈 목록으로 진행한다
          try {
            const d = f.contentDocument, sel = d && d.getElementById("demdNumb"), it = d && d.getElementById("itemCode");
            if (sel) { const items = it ? [...it.options].filter((o) => o.value).map((o) => o.text.trim()) : []; f.remove(); return resolve({ list: [], items }); }
          } catch (e) { /* 아래에서 실패 처리 */ }
          f.remove(); return reject(new Error("EDI 작업장 목록을 읽지 못했어요"));
        }
        setTimeout(tick, 500);
      };
      f.onload = () => setTimeout(tick, 300);
    });
  }

  // 동기화 도중 다른 계정으로 바뀌면(로그아웃 후 재로그인) 데이터가 섞이므로, 저장 직전에 계정을 다시 확인한다
  let lastCheck = 0;
  async function assertAccount() {
    if (Date.now() - lastCheck < 5000) return;
    const d = await demdInfo();
    if (d.code !== ACCOUNT) throw new Error("로그인 계정이 바뀌었어요(" + ACCOUNT + " → " + d.code + "). 데이터가 섞이지 않게 중단합니다");
    lastCheck = Date.now();
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

  // 이동등록 창의 입고처 목록(엑셀 업로드의 입고처코드·순번). 하루 한 번만 받는다(약 1MB)
  const DCOLS = "sStatus|sCheck|DEMD_CODE|DEMD_NUMB|GRUP_CODE|DEMD_NAME|POST_NAME|SELF_CODE|FULL_ADDR|FULL_ADR2|CHRG_NAME|CHRG_TELN|CHRG_HPNO|CHRG_FAXN|CHRG_MAIL|CHRG_ADDR|CHRG_SDDR|CHRG_ADR2|CHRG_SDR2|POST_CODE|POST_NUMB|MOVE_FLAG|USAG_FLAG|BLOK_LIST|FAVR_DEMD".split("|");
  async function pullDests(demd, inst) {
    const body = "S_SAVENAME=" + DCOLS.join("|") + "&userCode=" + encodeURIComponent(inst) + "&delvCode=" + encodeURIComponent(demd.code) + "&delvNumb=1";
    const text = await (await fetch("/edi/ware/EDI_WARE_MOVE_DETL_SEARCH.do", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body, credentials: "same-origin" })).text();
    if (text.indexOf("<?xml") < 0) throw new Error("EDI 응답이 비정상이에요(로그인 만료?)");
    const xml = new DOMParser().parseFromString(text.slice(text.indexOf("<?xml")), "text/xml");
    const out = [];
    xml.querySelectorAll("TR").forEach((tr) => {
      const o = {};
      tr.querySelectorAll("TD").forEach((td, i) => { o[DCOLS[i]] = td.textContent; });
      if (!o.DEMD_CODE || !o.DEMD_NUMB) return;
      out.push({ demd_code: o.DEMD_CODE, demd_numb: num(o.DEMD_NUMB), grup_code: o.GRUP_CODE, demd_name: o.DEMD_NAME, post_name: o.POST_NAME, self_code: o.SELF_CODE, addr: o.FULL_ADDR, usag_flag: o.USAG_FLAG, blok_list: o.BLOK_LIST });
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
    const demd = await demdInfo();
    ACCOUNT = demd.code; TAG = (demd.name || demd.code).replace(/^\(주\)/, "");
    if (Date.now() - getLast(ACCOUNT) < MIN_INTERVAL_MS) {
      const ago = Math.max(1, Math.round((Date.now() - getLast(ACCOUNT)) / 60000));
      say("방금(" + ago + "분 전) 동기화했어요. 지금 다시 하려면 Tampermonkey 메뉴의 'LETUS PMS · 지금 다시 동기화'를 누르세요");
      return;
    }

    say("동기화 준비 중…", true);
    const combos = await readCombos();
    await call("register_account", { name: demd.name, items: combos.items });
    await call("register_workplaces", { list: combos.list });
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
      let from = last_date ? addDays(parse(last_date), -(REFRESH_DAYS - 1)) : parse(START_DATE);
      if (from < parse(START_DATE)) from = parse(START_DATE);
      let guard = 0;
      while (from <= yesterday && guard++ < 60) {
        const to = new Date(Math.min(addDays(from, MOVE_CHUNK_DAYS - 1), yesterday));
        say(`이동 내역 ${fmt(from)}~${fmt(to)} 조회 중…`, true);
        const rows = await pullMoves(demd, inst, fmt(from), fmt(to));
        rows.forEach((r) => { movedNames.add(r.from_name); movedNames.add(r.to_name); });
        if (rows.length) { await assertAccount(); await call("moves_upsert", { rows, note: fmt(from) + "~" + fmt(to) }); mv += rows.length; }
        from = addDays(to, 1);
      }
    } catch (e) {
      mvErr = e.message;
      if (/로그인 만료|토큰이|주소가|anon 키가|로그인 계정이 바뀌었어요/.test(e.message)) st.abort = true;
    }

    // ── 1-1) 입고처 목록 (하루 한 번) ──
    let dsTxt = "";
    const dkey = "dests_" + ACCOUNT;
    if (!st.abort && GM_getValue(dkey) !== fmt(new Date())) {
      try {
        say("입고처 목록 받는 중…", true);
        const rows = await pullDests(demd, await instEmpn());
        if (rows.length) { await assertAccount(); await call("dests_upsert", { rows }); GM_setValue(dkey, fmt(new Date())); dsTxt = ` · 입고처 ${rows.length}곳`; }
      } catch (e) { dsTxt = " · 입고처 목록 실패: " + e.message; }
    }

    // ── 2) 재고: 못 받은 작업장 + 이동이 있었던 작업장(최근 3일 다시) + 전체 합계(0번) ──
    const refreshFrom = new Date(Math.max(addDays(yesterday, -(REFRESH_DAYS - 1)), parse(START_DATE))); // 이동이 있던 작업장: 7일
    // EDI는 "어제" 재고를 이동이 있었던 작업장부터 먼저 채우고 나머지는 하루 뒤에 채운다 → 모든 작업장은 최근 2일을 항상 다시 받는다
    const recentFrom = new Date(Math.max(addDays(yesterday, -1), parse(START_DATE)));
    const refresh = new Set(workplaces.filter((w) => w.no === 0 || movedNames.has(w.name)).map((w) => w.no));
    todo = st.abort ? [] : workplaces.slice(); // 모든 작업장을 확인한다(최근 2일은 다시 받음)
    let next = 0;
    async function worker() {
      while (!st.abort) {
        const w = todo[next++];
        if (!w) return;
        try {
          let from = w.last_synced ? addDays(parse(w.last_synced), 1) : parse(START_DATE);
          if (w.last_synced) { const rf = refresh.has(w.no) ? refreshFrom : recentFrom; if (rf < from) from = rf; }
          let guard = 0, any = false;
          while (from <= yesterday && guard++ < 10) {
            const to = new Date(Math.min(addDays(from, CHUNK_DAYS - 1), yesterday));
            say(`${w.name} ${fmt(from)}~${fmt(to)} 조회 중… (${label()})`, true);
            let rows;
            for (let t = 0; ; t++) { // 일시 오류는 최대 2번 재시도
              try { rows = await pull(demd, w.no, fmt(from), fmt(to)); break; }
              catch (e) { if (/로그인 만료/.test(e.message) || t >= 2) throw e; await sleep(4000 * (t + 1)); }
            }
            if (rows.length) { await assertAccount(); await call("upsert", { rows, note: "userscript " + w.name }); st.total += rows.length; any = true; }
            from = addDays(to, 1);
          }
          if (!any && (!w.last_synced || parse(w.last_synced) < yesterday)) { // 재고가 전혀 없는 작업장: 조회했다는 표시만 남겨 다음부터 건너뛴다
            const z = { stoc_date: fmt(yesterday), workplace_no: w.no, item: "-", last_stoc: 0, rental_in: 0, move_in: 0, move_out: 0, return_out: 0, this_stoc: 0, raw: null };
            await assertAccount(); await call("upsert", { rows: [z], note: "userscript(빈 작업장) " + w.name }); st.idle++;
          }
          st.done++;
        } catch (e) {
          st.failed++; st.lastErr = w.name + ": " + e.message;
          if (/로그인 만료|EDI 작업장 코드/.test(e.message)) st.abort = true; // EDI 세션이 끊기면 전체 중단(다음 접속 때 이어서)
          if (/토큰이|주소가|anon 키가|로그인 계정이 바뀌었어요/.test(e.message)) st.abort = true;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    setLast(ACCOUNT, st.failed || mvErr ? 0 : Date.now()); // 실패가 있으면 다음 접속 때 바로 이어서 재시도
    const mvTxt = (mvErr ? ` · 이동내역 실패: ${mvErr}` : ` · 이동 ${mv}건`) + dsTxt;
    say(st.abort ? `중단됨 · ${label()} — ${st.lastErr || mvErr} (다시 접속하면 이어서 받아요)`
      : st.failed ? `완료 ${label()} · 마지막 오류 ${st.lastErr}${mvTxt}`
      : `동기화 완료 · 재고 ${st.done}곳 ${st.total}행${mvTxt} (어제까지)`, st.abort || st.failed || !!mvErr);
  }

  // ── EDI 이동등록(추가) 창: PMS 대기열을 출고처별로 표에 채운다. 저장은 사람이 누른다 ──
  async function runFill() {
    const W = unsafeWindow;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await wait(300); } return false; };
    if (!(await until(() => W.mySheet2 && W.mySheet1 && W.$ && W.$("#delvCode").val()))) return;
    if (!GM_getValue("fnUrl") || !GM_getValue("anon") || !GM_getValue("token")) return; // 메인 화면에서 먼저 설정
    ACCOUNT = W.$("#delvCode").val(); TAG = "자동입력";
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed;right:10px;top:10px;z-index:99999;background:#0f1424;color:#fff;font:12px/1.5 sans-serif;padding:10px 12px;border-radius:10px;width:300px;max-height:70vh;overflow:auto;box-shadow:0 4px 14px rgba(0,0,0,.3)";
    document.body.appendChild(panel);
    const bySlip = {}; const reported = new Set();
    const render = async () => {
      panel.innerHTML = "<b>LETUS PMS · EDI 자동입력</b><div style='opacity:.7'>불러오는 중…</div>";
      let rows;
      try { rows = (await call("queue_list", {})).rows || []; } catch (e) { panel.innerHTML = "<b>LETUS PMS</b><div>대기열을 못 읽었어요: " + e.message + "</div>"; return; }
      rows.forEach((r) => { bySlip[r.note] = r; });
      const g = {};
      rows.forEach((r) => { (g[r.from_local] = g[r.from_local] || { local: r.from_local, name: r.from_name, rows: [] }).rows.push(r); });
      const list = Object.values(g);
      panel.innerHTML = "<b>LETUS PMS · EDI 자동입력</b> <span style='opacity:.7'>(" + ACCOUNT + ")</span>" +
        (list.length ? "<div style='opacity:.75;margin:4px 0 6px'>출고처를 골라 [채우기] → 노란 줄 확인 → EDI [저장]. 저장하면 PMS에 바로 반영돼요.</div>" : "<div style='opacity:.75;margin-top:4px'>PMS에서 보낸 대기 건이 없어요. (PMS › EDI 반영 › EDI 자동입력 보내기)</div>");
      list.forEach((x) => {
        const d = document.createElement("div");
        d.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 0;border-top:1px solid rgba(255,255,255,.12)";
        const qty = x.rows.reduce((a, r) => a + r.qty, 0);
        d.innerHTML = "<div style='flex:1'>" + x.local + ". " + (x.name || "") + "<div style='opacity:.65'>" + x.rows.length + "건 · " + qty + "장</div></div>";
        const b = document.createElement("button");
        b.textContent = "채우기"; b.style.cssText = "background:#1D9E75;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer";
        b.onclick = () => fill(x).catch((e) => alert("채우기 실패: " + e.message));
        d.appendChild(b); panel.appendChild(d);
      });
      const rb = document.createElement("button");
      rb.textContent = "새로고침"; rb.style.cssText = "margin-top:6px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:3px 10px;cursor:pointer";
      rb.onclick = render; panel.appendChild(rb);
    };
    const fill = async (x) => {
      const S2 = W.mySheet2, S1 = W.mySheet1, $ = W.$;
      if (![...document.getElementById("postName").options].some((o) => o.value === String(x.local))) throw new Error("출고처 작업장 " + x.local + "번이 이 계정 목록에 없어요");
      if (S2.RowCount() > 0 && !confirm("아래 표에 이미 " + S2.RowCount() + "줄이 있어요. 비우고 '" + x.name + "' 건으로 채울까요?")) return;
      $("#postName").val(String(x.local)); W.fnDelvNumb();
      await until(() => $("#delvNumb").val() === String(x.local) && S2.GetComboInfo(0, "ITEM_CODE", "Text"));
      await wait(800);
      W.doAction("search");
      if (!(await until(() => S1.SearchRows() > 0))) throw new Error("입고처 목록을 못 불러왔어요");
      S2.RemoveAll();
      const codes = S2.GetComboInfo(0, "ITEM_CODE", "Code").split("|"), texts = S2.GetComboInfo(0, "ITEM_CODE", "Text").split("|");
      const miss = [];
      for (const r of x.rows) {
        const code = codes[texts.indexOf(r.item)];
        if (!code) { miss.push(r.slip_no + "(" + r.item + ")"); continue; }
        W.doAction("add"); const n = S2.LastRow();
        const set = (c, v) => S2.SetCellValue(n, c, v, 0);
        set("MOVE_DATE", r.move_date); set("TO_DATE", r.move_date); set("STOR_DATE", r.move_date);
        set("ITEM_CODE", code); set("MOVE_VOLM", r.qty);
        set("ORDE_CODE", r.orde_code); set("ORDE_NUMB", String(r.orde_numb)); set("STOR_CODE", r.orde_code); set("STOR_NUMB", String(r.orde_numb));
        set("CARS_INFO", r.cars_info || ""); set("MOVE_DESC", r.note || "");
      }
      W.mySheet2_OnLoadExcel(true); // EDI가 엑셀 업로드 때 하는 점검(입고처 이름, 사용금지·차단 노란 줄)을 그대로 실행
      if (miss.length) alert("이 출고처에서 쓸 수 없는 제품이라 뺀 건: " + miss.join(", "));
    };
    // 저장 후 EDI가 각 줄에 이동코드(M…)를 채우면 PMS에 바로 알린다
    setInterval(async () => {
      try {
        const S2 = W.mySheet2; if (!S2 || !S2.RowCount()) return;
        const out = [];
        for (let i = S2.HeaderRows(); i <= S2.LastRow(); i++) {
          const note = S2.GetCellValue(i, "MOVE_DESC"), mc = S2.GetCellValue(i, "MOVE_CODE");
          const q = bySlip[note];
          if (q && /^M/.test(String(mc || "")) && !reported.has(q.ship_id)) out.push({ ship_id: q.ship_id, move_code: mc });
        }
        if (!out.length) return;
        out.forEach((o) => reported.add(o.ship_id));
        const res = await call("queue_saved", { rows: out });
        say("EDI 저장 " + res.saved + "건을 PMS에 반영했어요");
        render();
      } catch (e) { /* 다음 주기에 다시 */ }
    }, 2000);
    render();
  }

  // Tampermonkey 메뉴: 1시간 제한을 무시하고 지금 다시 동기화
  GM_registerMenuCommand("LETUS PMS · 지금 다시 동기화", () => { GM_setValue("lastRunMap", "{}"); location.reload(); });

  if (/WARE_MOVE_DETL.do/.test(location.pathname)) { runFill().catch((e) => say("자동입력 실패: " + e.message)); return; }
  run().catch((e) => say("동기화 실패: " + e.message));
})();
