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
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
