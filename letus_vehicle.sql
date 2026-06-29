-- ============================================================
-- LETUS PMS — 출고 차량번호
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS vehicle_no TEXT;
