-- ============================================================
-- LETUS PMS — 전자 서명 + 입고담당자
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS receiver_name TEXT;  -- 입고확인한 담당자
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS out_sign_url  TEXT;  -- 출고 서명 이미지
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS in_sign_url   TEXT;  -- 입고 서명 이미지
