-- ============================================================
-- LETUS PMS — 입고 수량 불일치(수량상이) 처리
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS received_qty INT;       -- 실제 받은 수량
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS discrepancy  BOOLEAN DEFAULT false; -- 보낸 수량과 불일치
