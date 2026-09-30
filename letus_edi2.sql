-- ============================================================
-- LETUS PMS — EDI 동기화 대상 확대: 전체 합계(0번) + 운영 중인 센터
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
-- ============================================================

-- 0번 = EDI "모든작업장" 조회(AJ 전체 재고 합계)
INSERT INTO aj_workplace (no, name, kind, closed, sync_enabled)
VALUES (0, '전체 합계(모든작업장)', '합계', false, true)
ON CONFLICT (no) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, sync_enabled = true;

-- 운영 중인 센터·사업장 자동 동기화
UPDATE aj_workplace SET sync_enabled = true WHERE kind = '센터' AND NOT closed;
