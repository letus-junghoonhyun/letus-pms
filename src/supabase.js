import { createClient } from "@supabase/supabase-js";

// ──────────────────────────────────────────────────────────────
// ⚠️ 여기에 본인 Supabase 정보를 넣으세요.
// URL은 이미 채워뒀어요(정훈님 프로젝트).
// ANON KEY는 Supabase 대시보드 → Project Settings → API →
// "anon public" 키를 복사해서 아래 따옴표 안에 붙여넣으세요.
// (이 키는 공개돼도 안전한 키예요. 비밀 키 아님.)
// ──────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://xtqblxitzzrjzeqniigp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0cWJseGl0enpyanplcW5paWdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1ODk3ODAsImV4cCI6MjA5NzE2NTc4MH0.dUciMpAeQWXvTTMO0TnM9eqUx-98FzC3ETz8f98Xs18";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
