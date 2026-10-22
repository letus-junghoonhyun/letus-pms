-- ============================================================
-- LETUS PMS — EDI 자동 입력 대기열
--  · PMS "EDI 반영" 탭에서 [EDI 자동입력 보내기] → 이 표에 쌓인다 (출고 1건 = 1행)
--  · EDI 이동등록(추가) 창에서 스크립트(v3.5)가 계정·출고처별로 표를 채우고, 사람이 [저장]
--  · 저장되면 EDI가 돌려준 이동코드로 바로 '반영' 처리 (동기화를 기다리지 않음)
-- ============================================================

CREATE TABLE IF NOT EXISTS aj_upload_queue (
  ship_id    TEXT PRIMARY KEY,          -- shipment.id
  slip_no    TEXT,
  account    TEXT NOT NULL,             -- EDI 계정(출고처 회사) 코드
  from_local INT  NOT NULL,             -- 출고처 작업장 번호(그 계정 기준)
  from_name  TEXT,
  move_date  TEXT NOT NULL,             -- YYYYMMDD
  item       TEXT NOT NULL,
  qty        INT  NOT NULL,
  orde_code  TEXT NOT NULL,             -- 입고처코드
  orde_numb  INT  NOT NULL,             -- 입고처순번
  to_name    TEXT,
  cars_info  TEXT,
  note       TEXT,                      -- 비고 (PMS 전표번호)
  status     TEXT NOT NULL DEFAULT '대기', -- 대기 / 저장 / 취소
  move_code  TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  saved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS aj_uq_acc ON aj_upload_queue (account, status);
ALTER TABLE aj_upload_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajuq select" ON aj_upload_queue;
CREATE POLICY "ajuq select" ON aj_upload_queue FOR SELECT TO authenticated USING (is_internal());

-- PMS에서 대기열에 올리기 (내부 사용자만). 같은 출고를 다시 올리면 덮어쓴다(이미 저장된 건 제외)
CREATE OR REPLACE FUNCTION public.edi_queue(p_rows JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  IF NOT is_internal() THEN RAISE EXCEPTION '권한이 없어요'; END IF;
  INSERT INTO aj_upload_queue (ship_id, slip_no, account, from_local, from_name, move_date, item, qty, orde_code, orde_numb, to_name, cars_info, note, status, created_at)
  SELECT r->>'ship_id', r->>'slip_no', r->>'account', (r->>'from_local')::int, r->>'from_name', r->>'move_date', r->>'item', (r->>'qty')::int,
         r->>'orde_code', (r->>'orde_numb')::int, r->>'to_name', r->>'cars_info', r->>'note', '대기', now()
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (ship_id) DO UPDATE SET
    slip_no = EXCLUDED.slip_no, account = EXCLUDED.account, from_local = EXCLUDED.from_local, from_name = EXCLUDED.from_name,
    move_date = EXCLUDED.move_date, item = EXCLUDED.item, qty = EXCLUDED.qty, orde_code = EXCLUDED.orde_code, orde_numb = EXCLUDED.orde_numb,
    to_name = EXCLUDED.to_name, cars_info = EXCLUDED.cars_info, note = EXCLUDED.note, status = '대기', created_at = now()
  WHERE aj_upload_queue.status <> '저장';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE shipment SET edi_status = '엑셀생성', edi_exported_at = now()
  WHERE id::text IN (SELECT r->>'ship_id' FROM jsonb_array_elements(p_rows) r) AND COALESCE(edi_status, '') <> '반영';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.edi_queue(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edi_queue(JSONB) TO authenticated;

-- 되돌리기·제외하면 대기열에서도 취소
CREATE OR REPLACE FUNCTION public.edi_mark(p_ids TEXT[], p_status TEXT, p_move_code TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  IF NOT is_internal() THEN RAISE EXCEPTION '권한이 없어요'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('엑셀생성','반영','제외') THEN RAISE EXCEPTION '잘못된 상태: %', p_status; END IF;
  UPDATE shipment SET
    edi_status = p_status,
    edi_exported_at = CASE WHEN p_status = '엑셀생성' THEN now() WHEN p_status IS NULL THEN NULL ELSE edi_exported_at END,
    edi_move_code = CASE WHEN p_status = '반영' THEN p_move_code WHEN p_status IS NULL THEN NULL ELSE edi_move_code END,
    edi_note = COALESCE(p_note, edi_note)
  WHERE id::text = ANY(p_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF p_status IS NULL OR p_status = '제외' THEN
    UPDATE aj_upload_queue SET status = '취소' WHERE ship_id = ANY(p_ids) AND status = '대기';
  END IF;
  RETURN n;
END $$;
