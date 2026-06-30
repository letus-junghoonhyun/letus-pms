-- ============================================================
-- LETUS PMS — 담당자(작업자) 정보: 연락처 + 전표 작업자 스냅샷
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;            -- 담당자 연락처
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS operator_name  TEXT;   -- 전표 작업자 이름(스냅샷)
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS operator_phone TEXT;   -- 전표 작업자 연락처(스냅샷)
