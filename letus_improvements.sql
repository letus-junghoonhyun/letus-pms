-- ============================================================
-- LETUS PMS — 개선 기능용 컬럼 추가
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요.
-- 여러 번 돌려도 안전합니다.
-- (출고 메모, 출고 취소(소프트 삭제)용 컬럼)
-- ============================================================

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS canceled BOOLEAN DEFAULT false;
