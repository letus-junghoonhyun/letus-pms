// ==UserScript==
// @name         LETUS PMS · EDI 재고 자동 동기화
// @namespace    letus-pms
// @version      1.3
// @description  EDI 로그인 후 메인 화면이 열리면, PMS에 없는 날짜부터 어제까지의 일별 재고를 조회해 PMS로 보냅니다.
// @match        http://edi.ajuprs.com/main_frame.do
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *.supabase.co
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
  const CHUNK_DAYS = 31;      // 한 번에 조회할 최대 일수
  const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1시간 안에 다시 열면 건너뜀

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
    const doc = new DOMParser().parseFromString(html, "text/html");
    const code = doc.getElementById("demdCode"), name = doc.getElementById("demdName");
    if (!code) throw new Error("EDI 로그인 상태가 아니에요");
    return { code: code.getAttribute("value") || "", name: name ? name.getAttribute("value") || "" : "" };
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
    if (Date.now() - (GM_getValue("lastRun") || 0) < MIN_INTERVAL_MS) return;

    say("동기화 준비 중…", true);
    const demd = await demdInfo();
    const { workplaces } = await call("status", {});
    if (!workplaces || !workplaces.length) { say("동기화 대상 작업장이 없어요 (PMS에서 지정)"); return; }

    const yesterday = addDays(new Date(), -1);
    let total = 0, done = 0;
    for (const w of workplaces) {
      let from = w.last_synced ? addDays(parse(w.last_synced), 1) : addDays(yesterday, -60); // 처음이면 60일 전부터
      let guard = 0;
      while (from <= yesterday && guard++ < 20) {
        const to = new Date(Math.min(addDays(from, CHUNK_DAYS - 1), yesterday));
        say(`${w.name} ${fmt(from)}~${fmt(to)} 조회 중… (${done + 1}/${workplaces.length})`, true);
        const rows = await pull(demd, w.no, fmt(from), fmt(to));
        if (rows.length) { await call("upsert", { rows, note: "userscript " + w.name }); total += rows.length; }
        from = addDays(to, 1);
      }
      done++;
    }
    GM_setValue("lastRun", Date.now());
    say(total ? `동기화 완료 · ${total}행 반영 (어제까지)` : "이미 최신이에요 (어제까지 반영됨)");
  }

  run().catch((e) => say("동기화 실패: " + e.message));
})();
