-- ============================================================
-- LETUS PMS — 입고 확인 (받는 쪽 확인) + EDI 입고확인 연동 + 자동확인
--  · 받는 쪽(센터 작업자·시공팀·현장 담당)이 [맞게 받음] / [다르게 받음]
--  · 이동일 다음날까지 아무도 안 누르면 '자동확인'
--  · 맞게 받음·자동확인 → EDI 입고확인 대기(edi_conf='대기') → EDI 이동조회/관리 상자 [채우기] → 사람이 [입고확인]
--  · 다르게 받음 → 이동 수정요청(edi_fix) 자동 생성 → 관리자 승인 흐름
--  · 보는 범위: 관리자·운송팀·정산(센터 미지정) = 전체 / 센터 지정 작업자 = 내 센터 / 협력업체(시공팀) = 내 작업장
-- ============================================================

CREATE TABLE IF NOT EXISTS edi_receipt (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account        TEXT,
  move_code      TEXT,               -- EDI 이동코드 (PMS 건이 아직 EDI에 없으면 NULL)
  item           TEXT NOT NULL,
  ship_id        TEXT,               -- PMS 전표(shipment.id)
  move_date      DATE,
  move_type      TEXT,
  from_name      TEXT,
  to_name        TEXT,
  to_wp          INT,
  qty            INT,                -- 보낸 수량
  status         TEXT NOT NULL,      -- 확인 / 다름 / 자동확인
  recv_lines     JSONB,              -- 다름일 때 실제 받은 [{item, qty}]
  photos         TEXT[],
  note           TEXT,
  fix_id         UUID,
  edi_conf       TEXT NOT NULL DEFAULT '대기', -- 대기 / 완료 / 해당없음 / 보류
  confirmed_by   UUID,
  confirmed_name TEXT,
  confirmed_at   TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS edi_receipt_move ON edi_receipt (account, move_code, item) WHERE move_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS edi_receipt_ship ON edi_receipt (ship_id) WHERE ship_id IS NOT NULL AND move_code IS NULL;
CREATE INDEX IF NOT EXISTS edi_receipt_conf ON edi_receipt (account, edi_conf);
ALTER TABLE edi_receipt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "edrc select" ON edi_receipt;
CREATE POLICY "edrc select" ON edi_receipt FOR SELECT TO authenticated USING (is_internal());

-- 이름 정리 (EDI 표시용 접두어 제거) → 표준 작업장
CREATE OR REPLACE FUNCTION public.wp_of_name(p_name TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT no FROM aj_workplace
  WHERE name = btrim(regexp_replace(coalesce(p_name, ''), '^(\((폐쇄|차단_폐쇄)\)|\[차단_폐쇄\])', ''))
  ORDER BY closed, no LIMIT 1
$$;

-- 내가 받는 쪽으로 볼 수 있는 작업장 (NULL = 전체)
CREATE OR REPLACE FUNCTION public.my_recv_wps()
RETURNS INT[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r TEXT := my_role(); cs TEXT[];
BEGIN
  IF r IN ('관리자','운송팀','정산담당') THEN
    SELECT center_codes INTO cs FROM profiles WHERE id = auth.uid();
    IF cs IS NULL OR array_length(cs, 1) IS NULL THEN RETURN NULL; END IF;
    RETURN ARRAY(SELECT no FROM aj_workplace WHERE pms_center = ANY(cs) OR name = ANY(cs));
  ELSIF r = '협력업체' THEN
    RETURN ARRAY(SELECT no FROM aj_workplace WHERE partner_code = my_partner());
  END IF;
  RETURN ARRAY[]::INT[];
END $$;

-- 받을 것 목록: EDI 이동(아직 EDI 입고확인 안 된 것) + EDI에 아직 안 들어간 PMS 전표
CREATE OR REPLACE FUNCTION public.receipt_incoming(p_days INT DEFAULT 14)
RETURNS TABLE (src TEXT, account TEXT, move_code TEXT, item TEXT, qty INT, move_date DATE, move_type TEXT, from_name TEXT, to_name TEXT, to_wp INT,
               ship_id TEXT, slip_no TEXT, vehicle_no TEXT, out_photos JSONB, edi_conf TEXT, r_status TEXT, r_name TEXT, r_at TIMESTAMPTZ, r_recv JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE wps INT[] := my_recv_wps(); since DATE := (now() AT TIME ZONE 'Asia/Seoul')::date - greatest(1, least(p_days, 90));
BEGIN
  IF wps IS NOT NULL AND array_length(wps, 1) IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH m AS (
    SELECT mv.*, wp_of_name(mv.to_name) AS twp FROM aj_move mv
    WHERE mv.move_date >= since AND mv.qty > 0 AND mv.move_type IN ('이동출고','렌탈입고','이동입고')
  )
  SELECT 'edi'::TEXT, m.account, m.move_code, m.item, m.qty, m.move_date, m.move_type, m.from_name, m.to_name, m.twp,
         s.id::TEXT, s.slip_no::TEXT, s.vehicle_no::TEXT, to_jsonb(s.out_photos), CASE WHEN m.conf = '승인' THEN '완료' ELSE r.edi_conf END,
         CASE WHEN m.conf = '승인' AND r.status IS NULL THEN 'EDI확인' ELSE r.status END, r.confirmed_name, r.confirmed_at, r.recv_lines
  FROM m
  LEFT JOIN edi_receipt r ON r.account = m.account AND r.move_code = m.move_code AND r.item = m.item
  LEFT JOIN LATERAL (SELECT * FROM shipment sh WHERE sh.edi_move_code = m.move_code AND sh.pallet_code = m.item LIMIT 1) s ON true
  WHERE m.twp IS NOT NULL AND (wps IS NULL OR m.twp = ANY(wps))
  UNION ALL
  SELECT 'pms'::TEXT, NULL::TEXT, NULL::TEXT, sh.pallet_code, sh.qty, (sh.depart_at AT TIME ZONE 'Asia/Seoul')::date, sh.direction, sh.from_name, sh.to_partner_name, sh.to_wp,
         sh.id::TEXT, sh.slip_no::TEXT, sh.vehicle_no::TEXT, to_jsonb(sh.out_photos), r.edi_conf, r.status, r.confirmed_name, r.confirmed_at, r.recv_lines
  FROM shipment sh
  LEFT JOIN edi_receipt r ON r.ship_id = sh.id::TEXT AND r.move_code IS NULL
  WHERE NOT coalesce(sh.canceled, false) AND sh.to_wp IS NOT NULL AND sh.edi_move_code IS NULL
    AND (sh.depart_at AT TIME ZONE 'Asia/Seoul')::date >= since AND (wps IS NULL OR sh.to_wp = ANY(wps));
END $$;
REVOKE ALL ON FUNCTION public.receipt_incoming(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_incoming(INT) TO authenticated;

-- 확인 저장: [{src, account, move_code, item, ship_id, qty, move_date, move_type, from_name, to_name, to_wp, status:'확인'|'다름', recv:[{item,qty}], photos, note}]
CREATE OR REPLACE FUNCTION public.receipt_confirm(p_rows JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE wps INT[] := my_recv_wps(); x JSONB; n INT := 0; st TEXT; fx UUID; nm TEXT; conf TEXT;
BEGIN
  IF wps IS NOT NULL AND array_length(wps, 1) IS NULL THEN RAISE EXCEPTION '받는 작업장이 지정되지 않은 계정이에요'; END IF;
  SELECT coalesce(name, email) INTO nm FROM profiles WHERE id = auth.uid();
  FOR x IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF wps IS NOT NULL AND NOT ((x->>'to_wp')::int = ANY(wps)) THEN RAISE EXCEPTION '내 작업장으로 오는 건만 확인할 수 있어요'; END IF;
    st := CASE WHEN x->>'status' = '다름' THEN '다름' ELSE '확인' END;
    fx := NULL;
    -- 받는 쪽이 EDI 입고확인을 할 수 있는 건: 우리 계정의 이동출고·이동입고 (렌탈입고는 AJ가 처리)
    conf := CASE WHEN st = '다름' THEN '보류' WHEN x->>'move_type' = '렌탈입고' THEN '해당없음' ELSE '대기' END;
    IF st = '다름' AND x->>'move_code' IS NOT NULL THEN
      INSERT INTO edi_fix (account, move_code, move_date, from_name, to_name, before_lines, after_lines, reason, photos, status, requested_by, requested_name)
      VALUES (x->>'account', x->>'move_code', (x->>'move_date')::date, x->>'from_name', x->>'to_name',
              jsonb_build_array(jsonb_build_object('item', x->>'item', 'qty', (x->>'qty')::int)), x->'recv', coalesce(x->>'note', '받은 쪽 확인: 수량 다름'),
              CASE WHEN x ? 'photos' THEN ARRAY(SELECT jsonb_array_elements_text(x->'photos')) END, '요청', auth.uid(), nm)
      RETURNING id INTO fx;
    END IF;
    INSERT INTO edi_receipt (account, move_code, item, ship_id, move_date, move_type, from_name, to_name, to_wp, qty, status, recv_lines, photos, note, fix_id, edi_conf, confirmed_by, confirmed_name)
    VALUES (x->>'account', x->>'move_code', x->>'item', x->>'ship_id', (x->>'move_date')::date, x->>'move_type', x->>'from_name', x->>'to_name', (x->>'to_wp')::int, (x->>'qty')::int,
            st, x->'recv', CASE WHEN x ? 'photos' THEN ARRAY(SELECT jsonb_array_elements_text(x->'photos')) END, x->>'note', fx, conf, auth.uid(), nm)
    ON CONFLICT DO NOTHING;
    -- PMS 전표도 입고확인 (수량이 다르면 수량상이로)
    IF x->>'ship_id' IS NOT NULL THEN
      UPDATE shipment SET status = '입고확인', confirmed_at = now(),
        received_qty = CASE WHEN st = '다름' THEN coalesce((SELECT sum((l->>'qty')::int) FROM jsonb_array_elements(x->'recv') l WHERE l->>'item' = x->>'item'), 0) ELSE qty END,
        discrepancy = (st = '다름')
      WHERE id::text = x->>'ship_id' AND status <> '입고확인';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.receipt_confirm(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_confirm(JSONB) TO authenticated;

-- 자동확인: 이동일 다음날까지 아무도 안 누른 우리 작업장행 이동 (이동일 <= 오늘-2). 지난 미확인 전부도 이걸로 정리된다
CREATE OR REPLACE FUNCTION public.receipt_auto()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; cutoff DATE := (now() AT TIME ZONE 'Asia/Seoul')::date - 2;
BEGIN
  IF auth.uid() IS NOT NULL AND my_role() <> '관리자' THEN RAISE EXCEPTION '관리자만 실행할 수 있어요'; END IF;
  INSERT INTO edi_receipt (account, move_code, item, move_date, move_type, from_name, to_name, to_wp, qty, status, edi_conf, confirmed_name)
  SELECT m.account, m.move_code, m.item, m.move_date, m.move_type, m.from_name, m.to_name, wp_of_name(m.to_name), m.qty, '자동확인',
         CASE WHEN m.move_type = '렌탈입고' THEN '해당없음' ELSE '대기' END, '자동'
  FROM aj_move m
  WHERE m.move_date <= cutoff AND m.qty > 0 AND m.conf <> '승인' AND m.move_type IN ('이동출고','렌탈입고','이동입고')
    AND wp_of_name(m.to_name) IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- EDI에서 이미 입고확인된 건은 대기에서 완료로
  UPDATE edi_receipt r SET edi_conf = '완료' FROM aj_move m
  WHERE r.edi_conf = '대기' AND r.account = m.account AND r.move_code = m.move_code AND r.item = m.item AND m.conf = '승인';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.receipt_auto() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_auto() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
SELECT 'ok' AS result, (SELECT count(*) FROM edi_receipt) AS receipts;
