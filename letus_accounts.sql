-- ============================================================
-- LETUS PMS — 계정 관리 컬럼 추가
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요. (여러 번 안전)
-- 가입 이메일/회사명 표시, 계정 활성/비활성용 컬럼
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email   TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active  BOOLEAN DEFAULT true;
