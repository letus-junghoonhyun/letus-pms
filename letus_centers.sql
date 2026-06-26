-- ============================================================
-- LETUS PMS — 센터 마스터 + 계정별 담당 센터(복수)
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

-- 센터 마스터 (이름 기준)
CREATE TABLE IF NOT EXISTS app_center (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text UNIQUE NOT NULL,
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
INSERT INTO app_center (name) VALUES ('양지물류센터'), ('안성센터'), ('평택센터')
  ON CONFLICT (name) DO NOTHING;

ALTER TABLE app_center ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appcenter select" ON app_center;
CREATE POLICY "appcenter select" ON app_center FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "appcenter insert" ON app_center;
CREATE POLICY "appcenter insert" ON app_center FOR INSERT TO authenticated WITH CHECK (my_role() IN ('관리자','운송팀'));
DROP POLICY IF EXISTS "appcenter update" ON app_center;
CREATE POLICY "appcenter update" ON app_center FOR UPDATE TO authenticated USING (my_role() IN ('관리자','운송팀')) WITH CHECK (my_role() IN ('관리자','운송팀'));

-- 계정별 담당 센터(복수) — 센터 이름 배열
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS center_codes text[];
