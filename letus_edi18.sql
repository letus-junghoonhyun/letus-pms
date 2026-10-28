-- ============================================================
-- LETUS PMS — 입고 타이밍 측정 + 상이 처리 경로
--  · aj_move.first_seen: PMS가 그 EDI 이동을 처음 본 시각 (AJ가 실제 입고보다 얼마나 먼저 EDI에 올리는지 측정)
--  · edi_fix.fix_type: 수정(우리끼리 이동) / 거부(다른 회사가 보낸 이동 → EDI 승인거부 '수량불일치') / AJ(렌탈입고·반납출고 → 수정요청 게시판)
-- ============================================================
ALTER TABLE aj_move ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ;
ALTER TABLE aj_move ALTER COLUMN first_seen SET DEFAULT now();
ALTER TABLE edi_fix ADD COLUMN IF NOT EXISTS fix_type TEXT;
UPDATE edi_fix SET fix_type = CASE WHEN move_code ~ '^[DS]' THEN 'AJ' ELSE '수정' END WHERE fix_type IS NULL;
NOTIFY pgrst, 'reload schema';
SELECT 'ok18' AS result;
