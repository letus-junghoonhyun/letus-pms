-- ============================================================
-- LETUS PMS — 정리 단계
--  A) 입고확인 EDI 정책: 지난 자동확인분은 EDI에 안 보냄(보류). 앞으로도 자동확인은 설정을 켜기 전까지 PMS에만
--  B) 납품요청 목록 동기화 (aj_call) — EDI에서 직접 넣은 요청까지
--  C) 시공팀(협력업체 역할) 앱 사용: 자기 현장에서 출고 등록, 작업장 목록 읽기
-- ============================================================

-- A) 설정 + 자동확인 EDI 보내기 여부 (기본: 안 보냄)
CREATE TABLE IF NOT EXISTS pms_setting (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE pms_setting ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pset select" ON pms_setting;
CREATE POLICY "pset select" ON pms_setting FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pset write" ON pms_setting;
CREATE POLICY "pset write" ON pms_setting FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
INSERT INTO pms_setting (key, value) VALUES ('auto_conf_to_edi', 'N') ON CONFLICT (key) DO NOTHING;

-- 지난 자동확인분은 EDI 입고확인 대기에서 보류로 (마감 때 정리)
UPDATE edi_receipt SET edi_conf = '보류' WHERE status = '자동확인' AND edi_conf = '대기';

CREATE OR REPLACE FUNCTION public.receipt_auto()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; cutoff DATE := (now() AT TIME ZONE 'Asia/Seoul')::date - 2;
        to_edi BOOLEAN := coalesce((SELECT value FROM pms_setting WHERE key = 'auto_conf_to_edi'), 'N') = 'Y';
BEGIN
  IF auth.uid() IS NOT NULL AND my_role() <> '관리자' THEN RAISE EXCEPTION '관리자만 실행할 수 있어요'; END IF;
  WITH wp AS (SELECT DISTINCT ON (w.name) w.name, w.no FROM aj_workplace w ORDER BY w.name, w.closed, w.no)
  INSERT INTO edi_receipt (account, move_code, item, move_date, move_type, from_name, to_name, to_wp, qty, status, edi_conf, confirmed_name)
  SELECT m.account, m.move_code, m.item, m.move_date, m.move_type, m.from_name, m.to_name, wp.no, m.qty, '자동확인',
         CASE WHEN m.move_type = '렌탈입고' THEN '해당없음' WHEN to_edi THEN '대기' ELSE '보류' END, '자동'
  FROM aj_move m
  JOIN wp ON wp.name = btrim(regexp_replace(coalesce(m.to_name, ''), '^(\((폐쇄|차단_폐쇄)\)|\[차단_폐쇄\])', ''))
  WHERE m.move_date <= cutoff AND m.qty > 0 AND m.conf <> '승인' AND m.move_type IN ('이동출고','렌탈입고','이동입고')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE edi_receipt r SET edi_conf = '완료' FROM aj_move m
  WHERE r.edi_conf IN ('대기','보류') AND r.account = m.account AND r.move_code = m.move_code AND r.item = m.item AND m.conf = '승인';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.receipt_auto() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_auto() TO authenticated, service_role;

-- B) 납품요청 목록 (EDI 납품요청/조회). 요청 1건이 제품별로 여러 줄
CREATE TABLE IF NOT EXISTS aj_call (
  account    TEXT NOT NULL,
  call_code  TEXT NOT NULL,           -- 요청코드 C…
  item       TEXT NOT NULL,
  local_no   INT,                     -- 그 계정의 작업장 번호
  post_name  TEXT,
  want_date  DATE,
  want_time  TEXT,
  cntr_type  TEXT,                    -- 보류 / 등록 / 접수 / 처리중 / 완료
  cars_oper  TEXT,                    -- AJ배차 / 내방
  call_volm  INT,
  inst_date  TEXT,
  inst_empn  TEXT,
  chrg_name  TEXT,
  synced_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account, call_code, item)
);
CREATE INDEX IF NOT EXISTS aj_call_want ON aj_call (want_date);
ALTER TABLE aj_call ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajcl select" ON aj_call;
CREATE POLICY "ajcl select" ON aj_call FOR SELECT TO authenticated USING (is_internal());

-- C) 시공팀: 작업장 목록·계정 번호는 읽을 수 있게 (출고처·입고처 고르기). 재고·이동 원장은 계속 내부만
DROP POLICY IF EXISTS "ajwp select" ON aj_workplace;
CREATE POLICY "ajwp select" ON aj_workplace FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ajwm select" ON aj_workplace_map;
CREATE POLICY "ajwm select" ON aj_workplace_map FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ajac select" ON aj_account;
CREATE POLICY "ajac select" ON aj_account FOR SELECT TO authenticated USING (true);

-- 시공팀은 자기 현장(작업장)에서 나가는 건 등록 가능, 자기 현장이 출발·도착인 건은 볼 수 있음
DROP POLICY IF EXISTS "ship insert" ON shipment;
CREATE POLICY "ship insert" ON shipment FOR INSERT TO authenticated
  WITH CHECK (
    my_role() IN ('관리자','운송팀')
    OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '반납')
    OR (my_role() = '협력업체' AND from_wp IN (SELECT no FROM aj_workplace WHERE partner_code = my_partner()))
  );
DROP POLICY IF EXISTS "ship select" ON shipment;
CREATE POLICY "ship select" ON shipment FOR SELECT TO authenticated
  USING (is_internal() OR (my_role() = '협력업체' AND (to_partner = my_partner() OR from_wp IN (SELECT no FROM aj_workplace WHERE partner_code = my_partner()))));
DROP POLICY IF EXISTS "mv insert" ON movement;
CREATE POLICY "mv insert" ON movement FOR INSERT TO authenticated
  WITH CHECK (my_role() IN ('관리자','운송팀') OR my_role() = '협력업체');

NOTIFY pgrst, 'reload schema';
SELECT 'ok16' AS result;
