-- ============================================================
-- LETUS PMS — 거래처·센터를 EDI 작업장 기준으로 반영 + 단가 일원화 + 12A 제외
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
-- ============================================================

-- 1) 12A는 사용하지 않음 → 단가표·정산에서 제외 (데이터는 그대로 보존)
UPDATE aj_pallet SET active = false, updated_at = now() WHERE code = '12A';

-- 2) 단가 일원화: "파렛트·단가"의 임대료가 기존 단가표(unit_price)에 자동 반영되도록
UPDATE unit_price u SET price = p.rent_price FROM aj_pallet p WHERE p.code = u.pallet_code AND p.rent_price IS NOT NULL;
CREATE OR REPLACE FUNCTION aj_pallet_sync_price() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.rent_price IS NOT NULL THEN
    UPDATE unit_price SET price = NEW.rent_price WHERE pallet_code = NEW.code;
    IF NOT FOUND THEN INSERT INTO unit_price (pallet_code, price, effective_from) VALUES (NEW.code, NEW.rent_price, current_date); END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_aj_pallet_price ON aj_pallet;
CREATE TRIGGER trg_aj_pallet_price AFTER INSERT OR UPDATE OF rent_price ON aj_pallet
  FOR EACH ROW EXECUTE FUNCTION aj_pallet_sync_price();

-- 3) 거래처: EDI 작업장 중 시공팀·업체(폐쇄 제외)를 거래처로 등록하고 서로 연결
INSERT INTO partner (code, name, type, aj_code, active)
SELECT 'W' || w.no, w.name, w.kind, w.no::text, true
FROM aj_workplace w
WHERE w.kind IN ('시공팀','업체') AND NOT w.closed AND w.no <> 0
  AND NOT EXISTS (SELECT 1 FROM partner p WHERE p.name = w.name)
  AND NOT EXISTS (SELECT 1 FROM partner p WHERE p.code = 'W' || w.no);
-- 이름이 같은 기존 거래처는 EDI 작업장 번호로 연결
UPDATE partner p SET aj_code = w.no::text
FROM aj_workplace w
WHERE p.name = w.name AND w.kind IN ('시공팀','업체') AND NOT w.closed AND (p.aj_code IS NULL OR p.aj_code !~ '^[0-9]+$');
UPDATE aj_workplace w SET partner_code = p.code FROM partner p WHERE p.aj_code = w.no::text;

-- 4) 센터: EDI의 운영 중인 센터·사업장을 PMS 센터로 등록하고 연결
INSERT INTO app_center (name, active)
SELECT w.name, true FROM aj_workplace w
WHERE w.kind = '센터' AND NOT w.closed AND NOT EXISTS (SELECT 1 FROM app_center c WHERE c.name = w.name);
UPDATE aj_workplace w SET pms_center = w.name WHERE w.kind = '센터' AND NOT w.closed AND w.pms_center IS NULL;

-- 5) 정산 계산: 사용하지 않는 파렛트(active=false, 예: 12A)는 제외
CREATE OR REPLACE FUNCTION aj_billing_calc(p_from date, p_to date, p_neg text DEFAULT 'zero', p_basis text DEFAULT 'this', p_default_unit int DEFAULT 2400)
RETURNS TABLE (workplace_no int, workplace_name text, kind text, item text, sum_qty bigint, avg_qty int, neg_days int, last_back int, unit int, unit_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_internal() THEN RAISE EXCEPTION '조회 권한이 없어요'; END IF;
  RETURN QUERY
  WITH d AS (SELECT (p_to - p_from + 1)::numeric AS days),
  v AS (
    SELECT s.workplace_no AS wno, s.item AS itm, s.stoc_date,
      SUM(CASE p_basis
        WHEN 'cont' THEN COALESCE(NULLIF(s.raw->>'CONT_STOC','')::int, s.this_stoc)
        WHEN 'back' THEN COALESCE(NULLIF(s.raw->>'BACK_STOC','')::int, s.this_stoc)
        WHEN 'conf' THEN COALESCE(NULLIF(s.raw->>'CONF_STOC','')::int, s.this_stoc)
        ELSE s.this_stoc END) AS q,
      SUM(COALESCE(NULLIF(s.raw->>'BACK_STOC','')::int, 0)) AS back
    FROM aj_stock_daily s
    WHERE s.item <> '-' AND s.workplace_no <> 0 AND s.stoc_date BETWEEN p_from AND p_to
    GROUP BY s.workplace_no, s.item, s.stoc_date
  ),
  g AS (
    SELECT v.wno, v.itm,
      SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END)::bigint AS sm,
      (COUNT(*) FILTER (WHERE v.q < 0))::int AS nd,
      (ARRAY_AGG(v.back ORDER BY v.stoc_date DESC))[1]::int AS lb
    FROM v GROUP BY v.wno, v.itm
    HAVING SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END) <> 0
  )
  SELECT g.wno, w.name, w.kind, g.itm, g.sm,
    CEIL(g.sm::numeric / (SELECT days FROM d))::int,
    g.nd, g.lb,
    (CASE WHEN p.rent_mode = 'actual' THEN ROUND(COALESCE(r.daily_rate, 0) * (SELECT days FROM d))::int
          ELSE COALESCE(p.rent_price, p_default_unit) END),
    (CASE WHEN p.rent_mode = 'actual' THEN 'actual' WHEN p.rent_price IS NULL THEN 'default' ELSE 'fixed' END)::text
  FROM g JOIN aj_workplace w ON w.no = g.wno
  LEFT JOIN aj_pallet p ON p.code = g.itm
  LEFT JOIN aj_cost_rate r ON r.code = g.itm
  WHERE COALESCE(p.active, true);
END $$;
REVOKE ALL ON FUNCTION aj_billing_calc(date, date, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION aj_billing_calc(date, date, text, text, int) TO authenticated;
