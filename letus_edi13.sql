-- ============================================================
-- LETUS PMS — EDI 이동 수정요청 (실제 받은 수량·제품이 다를 때)
--  · 작업자: EDI 이동 1건에 "실제 받은 것"(제품별 수량)을 적어 수정요청 (사진·사유)
--  · 관리자: 승인 / 반려. 승인하면
--      - 기존 제품 수량 변경 → EDI 이동조회/관리 화면 LETUS 상자에 "찾아서 고칠 건"으로 뜸
--      - 새로 생긴 제품(예: 14C 2장) → EDI 자동입력 대기열(aj_upload_queue)에 새 이동으로 들어감
--  · EDI에서 고친 뒤 [반영 완료] → status '반영'
-- ============================================================
CREATE TABLE IF NOT EXISTS edi_fix (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account        TEXT NOT NULL,
  move_code      TEXT NOT NULL,        -- EDI 이동코드
  move_date      DATE,
  from_name      TEXT,
  to_name        TEXT,
  before_lines   JSONB NOT NULL,       -- [{item, qty}] EDI에 등록된 것
  after_lines    JSONB NOT NULL,       -- [{item, qty}] 실제로 받은 것
  reason         TEXT,
  photos         TEXT[],
  status         TEXT NOT NULL DEFAULT '요청',  -- 요청 / 승인 / 반려 / 반영
  requested_by   UUID DEFAULT auth.uid(),
  requested_name TEXT,
  decided_by     UUID,
  decided_at     TIMESTAMPTZ,
  decide_note    TEXT,
  applied_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edi_fix_status ON edi_fix (account, status);
ALTER TABLE edi_fix ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "edfx select" ON edi_fix;
CREATE POLICY "edfx select" ON edi_fix FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "edfx insert" ON edi_fix;
CREATE POLICY "edfx insert" ON edi_fix FOR INSERT TO authenticated WITH CHECK (is_internal() AND status = '요청');

-- 승인·반려·반영 처리는 관리자만
CREATE OR REPLACE FUNCTION public.edi_fix_decide(p_id UUID, p_status TEXT, p_note TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF my_role() <> '관리자' THEN RAISE EXCEPTION '관리자만 처리할 수 있어요'; END IF;
  IF p_status NOT IN ('승인','반려','반영','요청') THEN RAISE EXCEPTION '잘못된 상태: %', p_status; END IF;
  UPDATE edi_fix SET status = p_status, decide_note = COALESCE(p_note, decide_note),
    decided_by = CASE WHEN p_status IN ('승인','반려') THEN auth.uid() ELSE decided_by END,
    decided_at = CASE WHEN p_status IN ('승인','반려') THEN now() ELSE decided_at END,
    applied_at = CASE WHEN p_status = '반영' THEN now() ELSE applied_at END
  WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.edi_fix_decide(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edi_fix_decide(UUID, TEXT, TEXT) TO authenticated;
NOTIFY pgrst, 'reload schema';
SELECT 'ok' AS result, (SELECT count(*) FROM edi_fix) AS fixes;
