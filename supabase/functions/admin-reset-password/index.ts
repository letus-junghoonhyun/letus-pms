// LETUS PMS — 관리자 비밀번호 초기화 Edge Function
// 호출자가 '관리자' 역할일 때만, 지정 사용자의 비밀번호를 새로 설정한다.
// service_role 키는 이 서버 함수 안에서만 사용(프론트에 절대 노출 안 함).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    // 1) 호출자 확인 (요청 헤더의 access token)
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json(401, { error: "로그인이 필요합니다." });

    // 2) 호출자가 관리자인지 확인
    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", caller.user.id).maybeSingle();
    if (roleRow?.role !== "관리자") return json(403, { error: "관리자만 사용할 수 있습니다." });

    // 3) 대상 사용자 비밀번호 변경
    const { userId, newPassword } = await req.json();
    if (!userId || !newPassword || String(newPassword).length < 6) return json(400, { error: "userId와 6자 이상 비밀번호가 필요합니다." });
    const { error } = await admin.auth.admin.updateUserById(userId, { password: String(newPassword) });
    if (error) return json(400, { error: error.message });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
