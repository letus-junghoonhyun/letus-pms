-- ============================================================
-- LETUS PMS — 센터 간 재고 이동
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
--
-- direction='이동' : center(출발센터) → to_center(도착센터)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS to_center TEXT;
-- 센터 이동은 거래처가 없으므로 to_partner 를 비울 수 있어야 함
ALTER TABLE shipment ALTER COLUMN to_partner DROP NOT NULL;
