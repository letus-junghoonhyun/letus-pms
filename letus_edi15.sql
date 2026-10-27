-- ============================================================
-- LETUS PMS — 입고 확인 수정
--  1) 저장 오류(cannot extract elements from a scalar): 사진·실제수량이 비어 있을 때 배열로 풀지 않게
--  2) 목록이 느리던 것: 작업장 이름 매칭을 줄마다 함수로 하던 것을 한 번에 조인으로
--  3) 1,000줄 제한: 화면이 페이지로 나눠 받도록 순서를 고정 (정렬 키 추가)
-- ============================================================
CREATE INDEX IF NOT EXISTS shipment_edi_move_code ON shipment (edi_move_code);
CREATE INDEX IF NOT EXISTS aj_move_date_type ON aj_move (move_date, move_type);

CREATE OR REPLACE FUNCTION public.receipt_incoming(p_days INT DEFAULT 14)
RETURNS TABLE (src TEXT, account TEXT, move_code TEXT, item TEXT, qty INT, move_date DATE, move_type TEXT, from_name TEXT, to_name TEXT, to_wp INT,
               ship_id TEXT, slip_no TEXT, vehicle_no TEXT, out_photos JSONB, edi_conf TEXT, r_status TEXT, r_name TEXT, r_at TIMESTAMPTZ, r_recv JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE wps INT[] := my_recv_wps(); since DATE := (now() AT TIME ZONE 'Asia/Seoul')::date - greatest(1, least(p_days, 90));
BEGIN
  IF wps IS NOT NULL AND array_length(wps, 1) IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH wp AS (SELECT DISTINCT ON (w.name) w.name, w.no FROM aj_workplace w ORDER BY w.name, w.closed, w.no),
  m AS (
    SELECT mv.account, mv.move_code, mv.item, mv.qty, mv.move_date, mv.move_type, mv.from_name, mv.to_name, mv.conf, wp.no AS twp
    FROM aj_move mv
    JOIN wp ON wp.name = btrim(regexp_replace(coalesce(mv.to_name, ''), '^(\((폐쇄|차단_폐쇄)\)|\[차단_폐쇄\])', ''))
    WHERE mv.move_date >= since AND mv.qty > 0 AND mv.move_type IN ('이동출고','렌탈입고','이동입고')
      AND (wps IS NULL OR wp.no = ANY(wps))
  )
  SELECT * FROM (
    SELECT 'edi'::TEXT, m.account, m.move_code, m.item, m.qty, m.move_date, m.move_type, m.from_name, m.to_name, m.twp,
           s.id::TEXT, s.slip_no::TEXT, s.vehicle_no::TEXT, to_jsonb(s.out_photos), CASE WHEN m.conf = '승인' THEN '완료' ELSE r.edi_conf END,
           CASE WHEN m.conf = '승인' AND r.status IS NULL THEN 'EDI확인' ELSE r.status END, r.confirmed_name, r.confirmed_at, r.recv_lines
    FROM m
    LEFT JOIN edi_receipt r ON r.account = m.account AND r.move_code = m.move_code AND r.item = m.item
    LEFT JOIN LATERAL (SELECT sh.id, sh.slip_no, sh.vehicle_no, sh.out_photos FROM shipment sh WHERE sh.edi_move_code = m.move_code AND sh.pallet_code = m.item LIMIT 1) s ON true
    UNION ALL
    SELECT 'pms'::TEXT, NULL::TEXT, NULL::TEXT, sh.pallet_code, sh.qty, (sh.depart_at AT TIME ZONE 'Asia/Seoul')::date, sh.direction, sh.from_name, sh.to_partner_name, sh.to_wp,
           sh.id::TEXT, sh.slip_no::TEXT, sh.vehicle_no::TEXT, to_jsonb(sh.out_photos), r.edi_conf, r.status, r.confirmed_name, r.confirmed_at, r.recv_lines
    FROM shipment sh
    LEFT JOIN edi_receipt r ON r.ship_id = sh.id::TEXT AND r.move_code IS NULL
    WHERE NOT coalesce(sh.canceled, false) AND sh.to_wp IS NOT NULL AND sh.edi_move_code IS NULL
      AND (sh.depart_at AT TIME ZONE 'Asia/Seoul')::date >= since AND (wps IS NULL OR sh.to_wp = ANY(wps))
  ) u (src, account, move_code, item, qty, move_date, move_type, from_name, to_name, to_wp, ship_id, slip_no, vehicle_no, out_photos, edi_conf, r_status, r_name, r_at, r_recv)
  ORDER BY u.move_date DESC, u.src, u.move_code, u.item, u.ship_id;
END $$;
REVOKE ALL ON FUNCTION public.receipt_incoming(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_incoming(INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.receipt_confirm(p_rows JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE wps INT[] := my_recv_wps(); x JSONB; n INT := 0; st TEXT; fx UUID; nm TEXT; conf TEXT; ph TEXT[]; rv JSONB;
BEGIN
  IF wps IS NOT NULL AND array_length(wps, 1) IS NULL THEN RAISE EXCEPTION '받는 작업장이 지정되지 않은 계정이에요'; END IF;
  SELECT coalesce(name, email) INTO nm FROM profiles WHERE id = auth.uid();
  FOR x IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF wps IS NOT NULL AND NOT ((x->>'to_wp')::int = ANY(wps)) THEN RAISE EXCEPTION '내 작업장으로 오는 건만 확인할 수 있어요'; END IF;
    st := CASE WHEN x->>'status' = '다름' THEN '다름' ELSE '확인' END;
    ph := CASE WHEN jsonb_typeof(x->'photos') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(x->'photos')) END;
    rv := CASE WHEN jsonb_typeof(x->'recv') = 'array' THEN x->'recv' END;
    fx := NULL;
    conf := CASE WHEN st = '다름' THEN '보류' WHEN x->>'move_type' = '렌탈입고' THEN '해당없음' ELSE '대기' END;
    IF st = '다름' AND x->>'move_code' IS NOT NULL THEN
      INSERT INTO edi_fix (account, move_code, move_date, from_name, to_name, before_lines, after_lines, reason, photos, status, requested_by, requested_name)
      VALUES (x->>'account', x->>'move_code', (x->>'move_date')::date, x->>'from_name', x->>'to_name',
              jsonb_build_array(jsonb_build_object('item', x->>'item', 'qty', (x->>'qty')::int)), coalesce(rv, '[]'::jsonb), coalesce(x->>'note', '받는 쪽 확인: 수량 상이'),
              ph, '요청', auth.uid(), nm)
      RETURNING id INTO fx;
    END IF;
    INSERT INTO edi_receipt (account, move_code, item, ship_id, move_date, move_type, from_name, to_name, to_wp, qty, status, recv_lines, photos, note, fix_id, edi_conf, confirmed_by, confirmed_name)
    VALUES (x->>'account', x->>'move_code', x->>'item', x->>'ship_id', (x->>'move_date')::date, x->>'move_type', x->>'from_name', x->>'to_name', (x->>'to_wp')::int, (x->>'qty')::int,
            st, rv, ph, x->>'note', fx, conf, auth.uid(), nm)
    ON CONFLICT DO NOTHING;
    IF x->>'ship_id' IS NOT NULL THEN
      UPDATE shipment SET status = '입고확인', confirmed_at = now(),
        received_qty = CASE WHEN st = '다름' THEN coalesce((SELECT sum((l->>'qty')::int) FROM jsonb_array_elements(coalesce(rv, '[]'::jsonb)) l WHERE l->>'item' = x->>'item'), 0) ELSE qty END,
        discrepancy = (st = '다름')
      WHERE id::text = x->>'ship_id' AND status <> '입고확인';
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.receipt_confirm(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_confirm(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.receipt_auto()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; cutoff DATE := (now() AT TIME ZONE 'Asia/Seoul')::date - 2;
BEGIN
  IF auth.uid() IS NOT NULL AND my_role() <> '관리자' THEN RAISE EXCEPTION '관리자만 실행할 수 있어요'; END IF;
  WITH wp AS (SELECT DISTINCT ON (w.name) w.name, w.no FROM aj_workplace w ORDER BY w.name, w.closed, w.no)
  INSERT INTO edi_receipt (account, move_code, item, move_date, move_type, from_name, to_name, to_wp, qty, status, edi_conf, confirmed_name)
  SELECT m.account, m.move_code, m.item, m.move_date, m.move_type, m.from_name, m.to_name, wp.no, m.qty, '자동확인',
         CASE WHEN m.move_type = '렌탈입고' THEN '해당없음' ELSE '대기' END, '자동'
  FROM aj_move m
  JOIN wp ON wp.name = btrim(regexp_replace(coalesce(m.to_name, ''), '^(\((폐쇄|차단_폐쇄)\)|\[차단_폐쇄\])', ''))
  WHERE m.move_date <= cutoff AND m.qty > 0 AND m.conf <> '승인' AND m.move_type IN ('이동출고','렌탈입고','이동입고')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE edi_receipt r SET edi_conf = '완료' FROM aj_move m
  WHERE r.edi_conf = '대기' AND r.account = m.account AND r.move_code = m.move_code AND r.item = m.item AND m.conf = '승인';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.receipt_auto() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_auto() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
SELECT 'ok15' AS result;
