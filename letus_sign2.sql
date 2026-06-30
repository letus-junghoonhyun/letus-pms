-- ============================================================
-- LETUS PMS — 입고담당자 연락처
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS receiver_phone TEXT;  -- 입고확인 담당자 연락처
