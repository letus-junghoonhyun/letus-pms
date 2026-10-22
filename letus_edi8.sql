-- ============================================================
-- LETUS PMS — EDI 반영(쓰기) 1단계: 업로드 엑셀 + 반영 확인
--  · aj_dest: EDI 이동등록 창의 입고처 목록(계정별). 동기화 스크립트 v3.4가 하루 한 번 채운다
--  · shipment.edi_*: PMS 출고·반납·이동이 EDI에 반영됐는지 (미반영 → 엑셀생성 → 반영)
--  · 엑셀 비고에 "PMS 전표번호"를 넣어서, EDI 이동 동기화 후 이동코드와 자동 연결한다
-- ============================================================

CREATE TABLE IF NOT EXISTS aj_dest (
  account    TEXT NOT NULL,             -- 로그인 계정(출고처) 코드
  demd_code  TEXT NOT NULL,             -- 입고처코드 (P…)
  demd_numb  INT  NOT NULL,             -- 입고처순번
  grup_code  TEXT,
  demd_name  TEXT,                      -- 업체명
  post_name  TEXT,                      -- 작업장명
  self_code  TEXT,                      -- 별칭 (사용금지 등)
  addr       TEXT,
  usag_flag  TEXT,                      -- Y = 사용 가능
  blok_list  TEXT,                      -- 3 포함 = 이동입고 차단
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account, demd_code, demd_numb)
);
CREATE INDEX IF NOT EXISTS aj_dest_name ON aj_dest (account, post_name);
ALTER TABLE aj_dest ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajds select" ON aj_dest;
CREATE POLICY "ajds select" ON aj_dest FOR SELECT TO authenticated USING (is_internal());

ALTER TABLE shipment ADD COLUMN IF NOT EXISTS edi_status      TEXT;        -- NULL=미반영 / 엑셀생성 / 반영 / 제외
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS edi_exported_at TIMESTAMPTZ;
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS edi_move_code   TEXT;        -- 연결된 EDI 이동코드
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS edi_note        TEXT;

-- 상태 변경은 내부 사용자만, 함수로만 (shipment 쓰기 권한과 분리)
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
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.edi_mark(TEXT[], TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edi_mark(TEXT[], TEXT, TEXT, TEXT) TO authenticated;
