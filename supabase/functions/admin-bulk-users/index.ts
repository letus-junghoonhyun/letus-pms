// LETUS PMS — 계정 일괄 등록 Edge Function
// 호출자가 '관리자'일 때만. 엑셀에서 읽은 행마다 계정을 만들고(이미 있으면 정보만 갱신) 바로 '승인' 상태로 둔다.
// 로그인 아이디 = 회사 메일(EP아이디@fursys.com). 임시 비밀번호를 만들어 돌려주고, 첫 로그인 때 바꾸게 한다(must_change_pw).
// service_role 키는 이 서버 함수 안에서만 사용(프론트에 노출 안 함).
// 배포: supabase functions deploy admin-bulk-users
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["관리자", "운송팀", "센터작업자", "정산담당", "협력업체", "업체", "AJ"];
const DOMAIN = "fursys.com";
const tempPw = () => "Letus" + Math.floor(100000 + Math.random() * 900000) + "!";

type Row = { empId?: string; email?: string; name?: string; role?: string; centers?: string[]; partnerCode?: string; phone?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json(401, { error: "로그인이 필요합니다." });
    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", caller.user.id).maybeSingle();
    if (roleRow?.role !== "관리자") return json(403, { error: "관리자만 사용할 수 있습니다." });

    const { rows } = (await req.json()) as { rows: Row[] };
    if (!Array.isArray(rows) || !rows.length) return json(400, { error: "rows가 비어 있어요." });
    if (rows.length > 300) return json(400, { error: "한 번에 300명까지 등록할 수 있어요." });

    // 이미 있는 계정(메일 기준) 찾기
    const existing = new Map<string, string>();
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      data.users.forEach((u) => u.email && existing.set(u.email.toLowerCase(), u.id));
      if (data.users.length < 1000) break;
    }

    const out: unknown[] = [];
    for (const r of rows) {
      const empId = String(r.empId || "").trim();
      const email = String(r.email || (empId ? (empId.includes("@") ? empId : `${empId}@${DOMAIN}`) : "")).trim().toLowerCase();
      const role = String(r.role || "").trim();
      if (!email) { out.push({ email, ok: false, error: "EP 아이디(메일)가 없어요" }); continue; }
      if (!ROLES.includes(role)) { out.push({ email, ok: false, error: `역할이 올바르지 않아요(${role})` }); continue; }
      try {
        let id = existing.get(email);
        let password: string | null = null;
        if (!id) {
          password = tempPw();
          const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: r.name || "", must_change_pw: true } });
          if (error) throw error;
          id = data.user.id;
          existing.set(email, id);
        }
        const prof: Record<string, unknown> = { id, email, name: r.name || null, emp_id: empId || email.split("@")[0], status: "승인", active: true };
        if (r.phone) prof.phone = r.phone;
        if (Array.isArray(r.centers)) prof.center_codes = r.centers.length ? r.centers : null;
        if (["협력업체", "업체"].includes(role)) prof.partner_code = r.partnerCode || null; else prof.partner_code = null;
        const { error: pe } = await admin.from("profiles").upsert(prof);
        if (pe) throw pe;
        const { error: re } = await admin.from("user_roles").upsert({ user_id: id, role }, { onConflict: "user_id" });
        if (re) throw re;
        out.push({ email, name: r.name, role, ok: true, created: !!password, password });
      } catch (e) {
        out.push({ email, ok: false, error: String((e as Error).message || e) });
      }
    }
    return json(200, { results: out });
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
