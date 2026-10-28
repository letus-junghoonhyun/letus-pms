// LETUS PMS — EDI 수신 함수 (계정별)
// EDI 사이트에서 돌아가는 사용자 스크립트(tools/edi-sync.user.js)가 조회한 재고·이동을 받아 DB에 넣는다.
// EDI 계정(14C·18F / 일반유형 11A·15A / 15A 전용 / 23E 전용)마다 로그인이 따로라서 요청마다 account(작업장코드)를 받는다.
// 인증: 함수 비밀값 EDI_INGEST_TOKEN 과 요청의 token 이 같아야 한다. (JWT 검증은 켠 채 사용). account 가 없는 요청은 거절한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 작업장 이름으로 종류 분류 (SQL 시드와 같은 규칙)
const kindOf = (name) => /(센터|사업장|창고|물류|PLT)/.test(name) ? "센터" : (/팀/.test(name) && !/사업부/.test(name) ? "시공팀" : "업체");
const clean = (name) => String(name || "").replace(/^\(폐쇄\)/, "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const expected = Deno.env.get("EDI_INGEST_TOKEN");
    if (!expected || body.token !== expected) return json({ error: "unauthorized" }, 401);

    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // 계정 정보가 없는 요청(옛 스크립트 v2.x)은 거절한다: 다른 계정의 데이터가 기존 계정에 섞이는 것을 막기 위해
    const account = String(body.account || "").trim();
    if (!account) return json({ error: "스크립트가 오래됐어요. Tampermonkey에서 v3.0 이상으로 업데이트해 주세요" }, 400);

    // 계정별 작업장 번호(local) → 표준 작업장 번호(wp)
    const loadMap = async () => {
      const { data, error } = await db.from("aj_workplace_map").select("local_no,wp_no").eq("account", account).limit(5000);
      if (error) throw new Error(error.message);
      return Object.fromEntries((data || []).map((m) => [m.local_no, m.wp_no]));
    };

    // 0) 계정 등록/갱신 (로그인할 때마다)
    if (body.action === "register_account") {
      const row = { code: account, last_seen: new Date().toISOString() };
      if (body.name) row.name = body.name;            // 값이 없으면 기존 값을 지우지 않는다
      if (body.items && body.items.length) row.items = body.items;
      const { error } = await db.from("aj_account").upsert(row, { onConflict: "code" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // 0-1) 이 계정의 작업장 목록 등록 — 이름이 같은 표준 작업장에 연결, 없으면 새로 만든다
    if (body.action === "register_workplaces") {
      const list = (body.list || []).filter((w) => w && Number.isInteger(w.no));
      const { data: wps, error: e1 } = await db.from("aj_workplace").select("no,name,closed").limit(5000);
      if (e1) return json({ error: e1.message }, 500);
      const byName = {};
      (wps || []).forEach((w) => { const k = clean(w.name); if (!byName[k] || (byName[k].closed && !w.closed)) byName[k] = w; });
      let maxNo = Math.max(999, ...(wps || []).map((w) => w.no));
      const have = await loadMap();
      const maps = []; const created = [];
      // 전체 합계(0번)는 항상 연결
      if (have[0] === undefined) maps.push({ account, local_no: 0, wp_no: 0, name: "전체 합계(모든작업장)", sync_enabled: true });
      for (const w of list) {
        if (w.no === 0 || have[w.no] !== undefined) continue;
        const nm = clean(w.name); const closed = /^\(폐쇄\)/.test(String(w.name || ""));
        let wp = byName[nm];
        if (!wp) {
          maxNo += 1;
          const row = { no: maxNo, name: nm, kind: kindOf(nm), closed, sync_enabled: !closed };
          const { error } = await db.from("aj_workplace").insert(row);
          if (error) return json({ error: error.message }, 500);
          wp = { no: maxNo, name: nm, closed }; byName[nm] = wp; created.push(nm);
        }
        maps.push({ account, local_no: w.no, wp_no: wp.no, name: nm, sync_enabled: !closed });
      }
      for (let i = 0; i < maps.length; i += 500) {
        const { error } = await db.from("aj_workplace_map").upsert(maps.slice(i, i + 500), { onConflict: "account,local_no" });
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true, mapped: maps.length, created: created.length });
    }

    // 1) 동기화 대상 작업장 + 마지막으로 받은 날짜 (이 계정 기준, 번호는 이 계정의 번호)
    if (body.action === "status") {
      const { data, error } = await db.from("aj_workplace_map")
        .select("local_no,last_synced,sync_enabled,aj_workplace(name,sync_enabled)")
        .eq("account", account).eq("sync_enabled", true).order("local_no").limit(5000);
      if (error) return json({ error: error.message }, 500);
      const workplaces = (data || [])
        .filter((m) => m.local_no === 0 || (m.aj_workplace && m.aj_workplace.sync_enabled))
        .map((m) => ({ no: m.local_no, name: m.aj_workplace ? m.aj_workplace.name : String(m.local_no), last_synced: m.last_synced }));
      return json({ workplaces });
    }

    // 2) 일별 재고 저장 (upsert). rows[].workplace_no 는 이 계정의 번호
    if (body.action === "upsert") {
      const map = await loadMap();
      const rows = [];
      for (const r of body.rows || []) {
        const wp = r.workplace_no === 0 ? 0 : map[r.workplace_no];
        if (wp === undefined) continue; // 등록되지 않은 작업장은 건너뜀
        rows.push({
          account, stoc_date: r.stoc_date, workplace_no: wp, item: r.item,
          last_stoc: r.last_stoc, rental_in: r.rental_in, move_in: r.move_in,
          move_out: r.move_out, return_out: r.return_out, this_stoc: r.this_stoc,
          raw: r.raw || null, synced_at: new Date().toISOString(),
        });
      }
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await db.from("aj_stock_daily").upsert(chunk, { onConflict: "account,stoc_date,workplace_no,item" });
        if (error) return json({ error: error.message }, 500);
        n += chunk.length;
      }
      // 작업장별 마지막 수집일 갱신 (계정별 + 표준 작업장)
      const maxBy = {};
      rows.forEach((r) => { if (!maxBy[r.workplace_no] || r.stoc_date > maxBy[r.workplace_no]) maxBy[r.workplace_no] = r.stoc_date; });
      for (const [wp, d] of Object.entries(maxBy)) {
        await db.from("aj_workplace_map").update({ last_synced: d }).eq("account", account).eq("wp_no", Number(wp));
        const { data: cur } = await db.from("aj_workplace").select("last_synced").eq("no", Number(wp)).maybeSingle();
        if (!cur || !cur.last_synced || cur.last_synced < d) await db.from("aj_workplace").update({ last_synced: d }).eq("no", Number(wp));
      }
      const dates = rows.map((r) => r.stoc_date).sort();
      await db.from("aj_sync_log").insert({
        account, from_date: dates[0] || null, to_date: dates[dates.length - 1] || null,
        workplaces: Object.keys(maxBy).length, rows_upserted: n, status: "ok", note: body.note || null,
      });
      return json({ ok: true, upserted: n });
    }

    // 3) 이동(건별) 마지막 일자 (이 계정 기준)
    if (body.action === "move_status") {
      const { data, error } = await db.from("aj_move").select("move_date").eq("account", account).order("move_date", { ascending: false }).limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ last_date: data && data.length ? data[0].move_date : null });
    }

    // 4) 이동(건별) 저장 (upsert: 수정·입고확인 상태 변경도 반영)
    if (body.action === "moves_upsert") {
      const rows = (body.rows || []).map((r) => ({
        account, move_code: r.move_code, move_date: r.move_date, item: r.item, from_name: r.from_name, to_name: r.to_name,
        move_type: r.move_type, iner: r.iner, qty: r.qty, chng: r.chng, conf: r.conf, retn: r.retn,
        bill_no: r.bill_no || null, note: r.note || null, synced_at: new Date().toISOString(),
      }));
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await db.from("aj_move").upsert(chunk, { onConflict: "account,move_code,item,from_name,to_name,move_date" });
        if (error) return json({ error: error.message }, 500);
        n += chunk.length;
      }
      const dates = rows.map((r) => r.move_date).sort();
      await db.from("aj_sync_log").insert({
        account, from_date: dates[0] || null, to_date: dates[dates.length - 1] || null,
        workplaces: 0, rows_upserted: n, status: "ok", note: "moves " + (body.note || ""),
      });
      return json({ ok: true, upserted: n });
    }
    // 5) 이동등록 창의 입고처 목록 (엑셀 업로드의 입고처코드·순번 확인용). 계정 단위로 통째로 바꾼다
    if (body.action === "dests_upsert") {
      const now = new Date().toISOString();
      const rows = (body.rows || []).filter((r) => r && r.demd_code && Number.isInteger(r.demd_numb)).map((r) => ({
        account, demd_code: r.demd_code, demd_numb: r.demd_numb, grup_code: r.grup_code || null, demd_name: r.demd_name || null,
        post_name: r.post_name || null, self_code: r.self_code || null, addr: r.addr || null, usag_flag: r.usag_flag || null,
        blok_list: r.blok_list || null, updated_at: now,
      }));
      if (!rows.length) return json({ error: "입고처 목록이 비어 있어요" }, 400);
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("aj_dest").upsert(rows.slice(i, i + 500), { onConflict: "account,demd_code,demd_numb" });
        if (error) return json({ error: error.message }, 500);
      }
      await db.from("aj_dest").delete().eq("account", account).lt("updated_at", now); // EDI에서 사라진 입고처 정리
      return json({ ok: true, upserted: rows.length });
    }
    // 6) 자동 입력 대기열: 이 계정에서 EDI에 넣을 PMS 출고 (이동등록 창 스크립트가 읽는다)
    if (body.action === "queue_list") {
      const { data, error } = await db.from("aj_upload_queue").select("*").eq("account", account).eq("status", "대기")
        .order("from_local").order("move_date").order("slip_no").limit(2000);
      if (error) return json({ error: error.message }, 500);
      return json({ rows: data || [] });
    }

    // 7) EDI에 저장된 행: EDI가 돌려준 이동코드로 바로 반영 처리
    if (body.action === "queue_saved") {
      let n = 0;
      for (const r of body.rows || []) {
        if (!r || !r.ship_id || !/^M/.test(String(r.move_code || ""))) continue;
        const { data: q } = await db.from("aj_upload_queue").select("ship_id").eq("ship_id", r.ship_id).eq("account", account).maybeSingle();
        if (!q) continue; // 이 계정 대기열에 없는 건은 무시
        await db.from("aj_upload_queue").update({ status: "저장", move_code: r.move_code, saved_at: new Date().toISOString() }).eq("ship_id", r.ship_id);
        const { error } = await db.from("shipment").update({ edi_status: "반영", edi_move_code: r.move_code }).eq("id", r.ship_id);
        if (!error) n++;
      }
      return json({ ok: true, saved: n });
    }
    // 8) AJ 공급요청 → EDI 납품요청 대기열 (납품요청/조회 화면 스크립트가 읽는다)
    if (body.action === "req_list") {
      const { data, error } = await db.from("aj_request").select("id,pallet_code,qty,center,wp_no,want_date,want_time,cars_oper,cars_tons,cars_type,phone,note,edi_group,edi_local,requested_at")
        .eq("edi_account", account).eq("edi_status", "대기").eq("status", "요청").order("requested_at").limit(500); // PMS에서 이미 처리·완료한 요청은 안 보여준다
      if (error) return json({ error: error.message }, 500);
      return json({ rows: data || [] });
    }
    // 9) EDI에 등록됨: 묶음 전체를 '등록'으로
    if (body.action === "req_saved") {
      if (!body.group) return json({ error: "group 없음" }, 400);
      const { data, error } = await db.from("aj_request").update({ edi_status: "등록", edi_call_code: String(body.call_code || "").slice(0, 200) })
        .eq("edi_account", account).eq("edi_group", body.group).eq("edi_status", "대기").select("id");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, saved: (data || []).length });
    }
    // 10) 납품기준수량(최소/11톤): 작업장·제품별
    if (body.action === "mins_upsert") {
      const now = new Date().toISOString();
      const rows = (body.rows || []).filter((r) => r && Number.isInteger(r.local_no) && r.item).map((r) => ({
        account, local_no: r.local_no, item: r.item, min1: Number.isFinite(r.min1) ? r.min1 : null, min2: Number.isFinite(r.min2) ? r.min2 : null, updated_at: now,
      }));
      if (!rows.length) return json({ error: "기준수량이 비어 있어요" }, 400);
      const { error } = await db.from("aj_item_min").upsert(rows, { onConflict: "account,local_no,item" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, upserted: rows.length });
    }
    // 9-1) 납품요청 상자에서 [빼기]: EDI로 안 보낼 묶음
    if (body.action === "req_skip") {
      if (!body.group) return json({ error: "group 없음" }, 400);
      const { error } = await db.from("aj_request").update({ edi_status: "취소" }).eq("edi_account", account).eq("edi_group", body.group).eq("edi_status", "대기");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // 11) 승인된 이동 수정요청 (이동조회/관리 화면 상자에서 찾아 고칠 건)
    if (body.action === "fix_list") {
      const { data, error } = await db.from("edi_fix").select("id,move_code,move_date,from_name,to_name,before_lines,after_lines,reason,decide_note,fix_type")
        .eq("account", account).eq("status", "승인").like("move_code", "M%").order("move_date").limit(200); // AJ 공급(D)·회수(S)는 이 화면에서 못 고쳐서 제외 → 수정요청 게시판
      if (error) return json({ error: error.message }, 500);
      return json({ rows: data || [] });
    }
    if (body.action === "fix_done") {
      if (!body.id) return json({ error: "id 없음" }, 400);
      const { error } = await db.from("edi_fix").update({ status: "반영", applied_at: new Date().toISOString() }).eq("id", body.id).eq("account", account).eq("status", "승인");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // 12) 자동확인: 이동일 다음날까지 아무도 안 누른 건 (동기화 끝에 호출)
    if (body.action === "receipt_auto") {
      const { data, error } = await db.rpc("receipt_auto");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, auto: data });
    }
    // 13) EDI 입고확인 대기 (이동조회/관리 상자에서 채울 것): 맞게 받음·자동확인 중 EDI에 아직 미확인
    if (body.action === "conf_list") {
      const out = [];
      for (let p = 0; p < 10; p++) {
        const { data, error } = await db.from("edi_receipt").select("move_code,move_date,item,to_name,status")
          .eq("account", account).eq("edi_conf", "대기").not("move_code", "is", null).in("status", ["확인", "자동확인"])
          .order("move_date").range(p * 1000, p * 1000 + 999);
        if (error) return json({ error: error.message }, 500);
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      // PMS 전표로 확인한 뒤 EDI에 반영된 건 (전표에 이동코드가 붙은 것)
      const { data: ships } = await db.from("edi_receipt").select("ship_id,item,status,move_date,to_name").is("move_code", null).eq("edi_conf", "대기").in("status", ["확인"]).limit(1000);
      for (const r of ships || []) {
        const { data: s } = await db.from("shipment").select("edi_move_code").eq("id", r.ship_id).maybeSingle();
        if (s && s.edi_move_code) out.push({ move_code: s.edi_move_code, move_date: r.move_date, item: r.item, to_name: r.to_name, status: r.status, ship_id: r.ship_id });
      }
      return json({ rows: out });
    }
    // 14) EDI에서 [입고확인] 눌러 저장된 이동코드들
    if (body.action === "conf_done") {
      const codes = (body.codes || []).filter((c) => /^M/.test(String(c))).slice(0, 5000);
      if (!codes.length) return json({ ok: true, done: 0 });
      let n = 0;
      for (let i = 0; i < codes.length; i += 300) {
        const { data, error } = await db.from("edi_receipt").update({ edi_conf: "완료" }).eq("account", account).in("move_code", codes.slice(i, i + 300)).eq("edi_conf", "대기").select("id");
        if (error) return json({ error: error.message }, 500);
        n += (data || []).length;
      }
      const { data: sh } = await db.from("shipment").select("id").in("edi_move_code", codes.slice(0, 1000));
      const ids = (sh || []).map((s) => String(s.id));
      if (ids.length) await db.from("edi_receipt").update({ edi_conf: "완료" }).in("ship_id", ids).is("move_code", null).eq("edi_conf", "대기");
      await db.from("aj_move").update({ conf: "승인" }).eq("account", account).in("move_code", codes.slice(0, 1000));
      return json({ ok: true, done: n });
    }
    // 15) 납품요청 목록 (EDI 납품요청/조회 — EDI에서 직접 넣은 요청 포함)
    if (body.action === "calls_upsert") {
      const now = new Date().toISOString();
      const rows = (body.rows || []).filter((r) => r && r.call_code && r.item).map((r) => ({
        account, call_code: r.call_code, item: r.item, local_no: Number.isInteger(r.local_no) ? r.local_no : null, post_name: r.post_name || null,
        want_date: r.want_date || null, want_time: r.want_time || null, cntr_type: r.cntr_type || null, cars_oper: r.cars_oper || null,
        call_volm: Number.isFinite(r.call_volm) ? r.call_volm : null, inst_date: r.inst_date || null, inst_empn: r.inst_empn || null, chrg_name: r.chrg_name || null, synced_at: now,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("aj_call").upsert(rows.slice(i, i + 500), { onConflict: "account,call_code,item" });
        if (error) return json({ error: error.message }, 500);
      }
      // 이번 조회 기간 안에서 EDI에서 사라진(삭제된) 요청은 정리
      if (body.from) await db.from("aj_call").delete().eq("account", account).gte("inst_date", body.from).lt("synced_at", now);
      return json({ ok: true, upserted: rows.length });
    }
    // 16) AJ 수정요청 게시판에 올릴 것: 승인된 AJ 공급(D)·회수(S) 상이
    if (body.action === "fix_aj_list") {
      const { data, error } = await db.from("edi_fix").select("id,move_code,move_date,from_name,to_name,before_lines,after_lines,reason,aj_text")
        .eq("account", account).eq("status", "승인").is("aj_rqst_code", null).or("move_code.like.D%,move_code.like.S%").order("move_date").limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ rows: data || [] });
    }
    if (body.action === "fix_aj_sent") {
      if (!body.id || !body.rqst_code) return json({ error: "id·요청번호 없음" }, 400);
      const { error } = await db.from("edi_fix").update({ aj_rqst_code: String(body.rqst_code).slice(0, 50), aj_sent_at: new Date().toISOString(), status: "반영", applied_at: new Date().toISOString() })
        .eq("id", body.id).eq("account", account);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
