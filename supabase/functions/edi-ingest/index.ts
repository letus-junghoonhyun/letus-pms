// LETUS PMS — EDI 재고 수신 함수
// EDI 사이트에서 돌아가는 사용자 스크립트(tools/edi-sync.user.js)가 조회한 일별 재고를 받아 DB에 넣는다.
// 인증: 함수 비밀값 EDI_INGEST_TOKEN 과 요청의 token 이 같아야 한다. (JWT 검증은 끄고 배포)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const expected = Deno.env.get("EDI_INGEST_TOKEN");
    if (!expected || body.token !== expected) return json({ error: "unauthorized" }, 401);

    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // 1) 동기화 대상 작업장 + 마지막으로 받은 날짜
    if (body.action === "status") {
      const { data, error } = await db.from("aj_workplace").select("no,name,last_synced").eq("sync_enabled", true).order("no");
      if (error) return json({ error: error.message }, 500);
      return json({ workplaces: data });
    }

    // 2) 일별 재고 저장 (upsert)
    if (body.action === "upsert") {
      const rows = (body.rows || []).map((r) => ({
        stoc_date: r.stoc_date, workplace_no: r.workplace_no, item: r.item,
        last_stoc: r.last_stoc, rental_in: r.rental_in, move_in: r.move_in,
        move_out: r.move_out, return_out: r.return_out, this_stoc: r.this_stoc,
        raw: r.raw || null, synced_at: new Date().toISOString(),
      }));
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await db.from("aj_stock_daily").upsert(chunk, { onConflict: "stoc_date,workplace_no,item" });
        if (error) return json({ error: error.message }, 500);
        n += chunk.length;
      }
      // 작업장별 마지막 동기화 일자 갱신
      const maxBy = {};
      rows.forEach((r) => { if (!maxBy[r.workplace_no] || r.stoc_date > maxBy[r.workplace_no]) maxBy[r.workplace_no] = r.stoc_date; });
      for (const [no, d] of Object.entries(maxBy)) {
        await db.from("aj_workplace").update({ last_synced: d }).eq("no", Number(no));
      }
      const dates = rows.map((r) => r.stoc_date).sort();
      await db.from("aj_sync_log").insert({
        from_date: dates[0] || null, to_date: dates[dates.length - 1] || null,
        workplaces: Object.keys(maxBy).length, rows_upserted: n, status: "ok", note: body.note || null,
      });
      return json({ ok: true, upserted: n });
    }
    // 3) 이동(건별) 마지막 일자
    if (body.action === "move_status") {
      const { data, error } = await db.from("aj_move").select("move_date").order("move_date", { ascending: false }).limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ last_date: data && data.length ? data[0].move_date : null });
    }

    // 4) 이동(건별) 저장 (upsert: 수정·입고확인 상태 변경도 반영)
    if (body.action === "moves_upsert") {
      const rows = (body.rows || []).map((r) => ({
        move_code: r.move_code, move_date: r.move_date, item: r.item, from_name: r.from_name, to_name: r.to_name,
        move_type: r.move_type, iner: r.iner, qty: r.qty, chng: r.chng, conf: r.conf, retn: r.retn,
        bill_no: r.bill_no || null, note: r.note || null, synced_at: new Date().toISOString(),
      }));
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await db.from("aj_move").upsert(chunk, { onConflict: "move_code,item,from_name,to_name,move_date" });
        if (error) return json({ error: error.message }, 500);
        n += chunk.length;
      }
      const dates = rows.map((r) => r.move_date).sort();
      await db.from("aj_sync_log").insert({
        from_date: dates[0] || null, to_date: dates[dates.length - 1] || null,
        workplaces: 0, rows_upserted: n, status: "ok", note: "moves " + (body.note || ""),
      });
      return json({ ok: true, upserted: n });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
