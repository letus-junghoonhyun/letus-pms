-- ============================================================
-- LETUS PMS — 입고확인 시각 기록
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요. (여러 번 안전)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
