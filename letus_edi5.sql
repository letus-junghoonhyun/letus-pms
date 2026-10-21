-- ============================================================
-- LETUS PMS — 파렛트 규격·단가(임대료/임차료) + AJ 임차료 명세서 + 규격별 단가 정산
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
--   임대료 = 우리가 브랜드(시공팀·업체)에 청구하는 금액
--   임차료 = AJ가 우리에게 청구하는 금액 (구내용 일단가 + 운송비 + 수송용)
-- ============================================================

-- 1) 파렛트 규격·임대료 (EDI 제품코드 기준). 조회=내부직원, 쓰기=관리자
CREATE TABLE IF NOT EXISTS aj_pallet (
  code        TEXT PRIMARY KEY,            -- 14C / 18F / 11A / 12A / 15A / 23E (EDI 제품코드)
  name        TEXT,
  category    TEXT,                        -- 표준형 / 제병용 / 대형 …
  width_mm    INT, depth_mm INT, height_mm INT,
  weight_kg   NUMERIC(6,1),
  image_url   TEXT,
  source_url  TEXT,
  rent_price  INT,                         -- 임대료(청구) 원/장·월. NULL=미정
  rent_mode   TEXT DEFAULT 'fixed',        -- fixed(고정 단가) / actual(실비: AJ 임차료 그대로 청구)
  rent_note   TEXT,
  sort        INT DEFAULT 0,
  active      BOOLEAN DEFAULT true,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
-- 2) AJ 임차료 단가 (관리자 전용)
CREATE TABLE IF NOT EXISTS aj_cost_rate (
  code        TEXT PRIMARY KEY REFERENCES aj_pallet(code) ON DELETE CASCADE,
  daily_rate  NUMERIC(8,2),                -- 구내용: 원/장·일
  move_fee    INT,                         -- 운송비: 원/장
  ship_fee    INT,                         -- 수송용: 원/장
  note        TEXT,
  valid_from  DATE DEFAULT current_date,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
-- 3) AJ 임차료 명세서 (월별, 관리자 전용)
CREATE TABLE IF NOT EXISTS aj_invoice (
  id          BIGSERIAL PRIMARY KEY,
  month       TEXT NOT NULL,               -- 정산월 'YYYY-MM'
  account     TEXT NOT NULL,               -- 계정 구분 (14C·18F / 일반유형(11A·15A) / 15A 전용 / 23E 전용)
  period_from DATE, period_to DATE, days INT,
  supply      BIGINT, vat BIGINT, total BIGINT,
  billed_on   DATE, due_on DATE,
  note        TEXT,
  UNIQUE (month, account)
);
CREATE TABLE IF NOT EXISTS aj_invoice_line (
  id          BIGSERIAL PRIMARY KEY,
  invoice_id  BIGINT NOT NULL REFERENCES aj_invoice(id) ON DELETE CASCADE,
  item        TEXT NOT NULL,               -- 제품 (14C+18F 처럼 묶음도 가능)
  kind        TEXT NOT NULL,               -- 운송실비 / 운송비 / 구내용 / 수송용 / 기타
  qty         NUMERIC(14,2),
  unit_price  NUMERIC(10,2),
  amount      BIGINT
);

ALTER TABLE aj_pallet       ENABLE ROW LEVEL SECURITY;
ALTER TABLE aj_cost_rate    ENABLE ROW LEVEL SECURITY;
ALTER TABLE aj_invoice      ENABLE ROW LEVEL SECURITY;
ALTER TABLE aj_invoice_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajpl select" ON aj_pallet;
CREATE POLICY "ajpl select" ON aj_pallet FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "ajpl write" ON aj_pallet;
CREATE POLICY "ajpl write" ON aj_pallet FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
DROP POLICY IF EXISTS "ajcr admin" ON aj_cost_rate;
CREATE POLICY "ajcr admin" ON aj_cost_rate FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
DROP POLICY IF EXISTS "ajiv admin" ON aj_invoice;
CREATE POLICY "ajiv admin" ON aj_invoice FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
DROP POLICY IF EXISTS "ajil admin" ON aj_invoice_line;
CREATE POLICY "ajil admin" ON aj_invoice_line FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');

-- 4) 시드: 규격·중량·이미지는 AJ네트웍스 제품안내(ajnetworks.co.kr), 임대료는 현행 청구 단가
INSERT INTO aj_pallet (code, name, category, width_mm, depth_mm, height_mm, weight_kg, image_url, source_url, rent_price, rent_mode, rent_note, sort) VALUES
 ('14C','제병용 파렛트 14C형','제병용',1438,1128,140,19.0,'https://ajnetworks.co.kr/assets/uploads/product/product_14C_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',2400,'fixed',NULL,1),
 ('18F','대형 파렛트 18F형','대형',1800,1130,150,56.0,'https://ajnetworks.co.kr/assets/uploads/product/product_18F_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',2400,'fixed',NULL,2),
 ('11A','표준형 파렛트 11A형','표준형',1100,1100,150,19.5,'https://ajnetworks.co.kr/assets/uploads/product/product_11A_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',13200,'fixed',NULL,3),
 ('12A','표준형 파렛트 12A형','표준형',1200,1000,150,19.0,'https://ajnetworks.co.kr/assets/uploads/product/product_12A_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',NULL,'fixed','단가 미정(사용 시 입력)',4),
 ('15A','표준형 파렛트 15A','표준형',1460,1130,150,27.5,'https://ajnetworks.co.kr/assets/uploads/product/product_15A_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',13200,'fixed','시디즈 쿠팡출고 사용분은 11A와 같은 13,200원으로 임대료 청구. 이케아 15A는 별도 계산서(15A 전용 계정)로 풀필에 실비 청구 — AJ 문의 후 계정별 단가로 정리 예정',5),
 ('23E','대형 파렛트 23E형','대형',2300,1600,140,66.0,'https://ajnetworks.co.kr/assets/uploads/product/product_23E_1.png','https://ajnetworks.co.kr/Product/L/1?cate=파렛트',7000,'fixed',NULL,6)
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, width_mm=EXCLUDED.width_mm, depth_mm=EXCLUDED.depth_mm,
  height_mm=EXCLUDED.height_mm, weight_kg=EXCLUDED.weight_kg, image_url=EXCLUDED.image_url, source_url=EXCLUDED.source_url;

-- AJ 임차료 단가: 2026-09 거래명세서 기준
INSERT INTO aj_cost_rate (code, daily_rate, move_fee, ship_fee, note) VALUES
 ('14C',43,1500,6500,'2026-09 명세서 (14C·18F 공통)'),
 ('18F',43,1500,6500,'2026-09 명세서 (14C·18F 공통)'),
 ('11A',24,500,2000,'2026-09 명세서'),
 ('15A',40,600,3200,'2026-09 명세서 (일반유형·15A 전용 동일 구내용 40원, 전용은 운송비·수송용 없음)'),
 ('23E',120,2500,0,'2026-09 명세서 (수송용 0)')
ON CONFLICT (code) DO NOTHING;

-- AJ 임차료 명세서 (사용기간 2026-08-26 ~ 09-25, 31일 / 청구일 09-30 / 납기 10-31)
INSERT INTO aj_invoice (month, account, period_from, period_to, days, supply, vat, total, billed_on, due_on, note) VALUES
 ('2026-09','14C·18F','2026-08-26','2026-09-25',31,90186790,9018679,99205469,'2026-09-30','2026-10-31','통합거래명세서'),
 ('2026-09','일반유형(11A·15A)','2026-08-26','2026-09-25',31,5262424,526242,5788666,'2026-09-30','2026-10-31',NULL),
 ('2026-09','15A 전용','2026-08-26','2026-09-25',31,913880,91388,1005268,'2026-09-30','2026-10-31','이케아 전용'),
 ('2026-09','23E 전용','2026-08-26','2026-09-25',31,1744680,174468,1919148,'2026-09-30','2026-10-31',NULL)
ON CONFLICT (month, account) DO NOTHING;
INSERT INTO aj_invoice_line (invoice_id, item, kind, qty, unit_price, amount)
SELECT i.id, v.item, v.kind, v.qty, v.unit_price, v.amount FROM aj_invoice i
JOIN (VALUES
 ('14C·18F','14C+18F','운송실비',117,NULL,175500),
 ('14C·18F','14C+18F','운송비',1805,1500,2707500),
 ('14C·18F','14C+18F','구내용',1784530,43,76734790),
 ('14C·18F','14C+18F','수송용',1626,6500,10569000),
 ('일반유형(11A·15A)','11A','운송비',916,500,458000),
 ('일반유형(11A·15A)','11A','구내용',9491,24,227784),
 ('일반유형(11A·15A)','11A','수송용',767,2000,1534000),
 ('일반유형(11A·15A)','15A','운송비',530,600,318000),
 ('일반유형(11A·15A)','15A','구내용',11876,40,475040),
 ('일반유형(11A·15A)','15A','수송용',703,3200,2249600),
 ('15A 전용','15A','구내용',22847,40,913880),
 ('23E 전용','23E','구내용',14539,120,1744680)
) AS v(account, item, kind, qty, unit_price, amount) ON v.account = i.account
WHERE i.month = '2026-09' AND NOT EXISTS (SELECT 1 FROM aj_invoice_line l WHERE l.invoice_id = i.id);

-- 5) 정산 계산: 규격별 임대료 단가 적용 (15A 실비는 구내용 일단가 × 기간 일수로 환산한 추정치)
DROP FUNCTION IF EXISTS aj_billing_calc(date, date, text, text);
CREATE OR REPLACE FUNCTION aj_billing_calc(p_from date, p_to date, p_neg text DEFAULT 'zero', p_basis text DEFAULT 'this', p_default_unit int DEFAULT 2400)
RETURNS TABLE (workplace_no int, workplace_name text, kind text, item text, sum_qty bigint, avg_qty int, neg_days int, last_back int, unit int, unit_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_internal() THEN RAISE EXCEPTION '조회 권한이 없어요'; END IF;
  RETURN QUERY
  WITH d AS (SELECT (p_to - p_from + 1)::numeric AS days),
  v AS (
    SELECT s.workplace_no AS wno, s.item AS itm, s.stoc_date,
      CASE p_basis
        WHEN 'cont' THEN COALESCE(NULLIF(s.raw->>'CONT_STOC','')::int, s.this_stoc)
        WHEN 'back' THEN COALESCE(NULLIF(s.raw->>'BACK_STOC','')::int, s.this_stoc)
        WHEN 'conf' THEN COALESCE(NULLIF(s.raw->>'CONF_STOC','')::int, s.this_stoc)
        ELSE s.this_stoc END AS q,
      NULLIF(s.raw->>'BACK_STOC','')::int AS back
    FROM aj_stock_daily s
    WHERE s.item <> '-' AND s.workplace_no <> 0 AND s.stoc_date BETWEEN p_from AND p_to
  ),
  g AS (
    SELECT v.wno, v.itm,
      SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END)::bigint AS sm,
      (COUNT(*) FILTER (WHERE v.q < 0))::int AS nd,
      (ARRAY_AGG(v.back ORDER BY v.stoc_date DESC))[1] AS lb
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
  LEFT JOIN aj_cost_rate r ON r.code = g.itm;
END $$;

-- 마감 확정: 규격별 단가로 확정 (p_unit = 단가 미설정 제품의 기본 단가)
CREATE OR REPLACE FUNCTION aj_billing_close_month(p_month text, p_unit int, p_neg text, p_basis text, p_note text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE y int; m int; f date; t date; tot bigint; qty bigint;
BEGIN
  IF COALESCE(my_role(), '') NOT IN ('관리자','정산담당') THEN RAISE EXCEPTION '마감 권한이 없어요'; END IF;
  IF EXISTS (SELECT 1 FROM aj_billing_close WHERE month = p_month) THEN RAISE EXCEPTION '이미 마감된 달이에요 (재오픈 후 다시 확정)'; END IF;
  y := split_part(p_month,'-',1)::int; m := split_part(p_month,'-',2)::int;
  f := make_date(y, m, 1) - interval '1 month' + interval '25 days';
  t := make_date(y, m, 25);
  IF (SELECT MAX(stoc_date) FROM aj_stock_daily WHERE item <> '-') < t THEN
    RAISE EXCEPTION '재고 데이터가 % 까지 들어와야 마감할 수 있어요 (현재 %)', t, (SELECT MAX(stoc_date) FROM aj_stock_daily WHERE item <> '-');
  END IF;
  INSERT INTO aj_billing_close (month, period_from, period_to, days, unit, neg_mode, basis, note, closed_by)
    VALUES (p_month, f, t, (t - f + 1), p_unit, p_neg, p_basis, p_note, COALESCE((SELECT email FROM profiles WHERE id = auth.uid()), auth.uid()::text));
  INSERT INTO aj_billing_line (month, workplace_no, workplace_name, kind, item, sum_qty, avg_qty, unit, amount)
    SELECT p_month, c.workplace_no, c.workplace_name, c.kind, c.item, c.sum_qty, c.avg_qty, c.unit, c.avg_qty::bigint * c.unit
    FROM aj_billing_calc(f, t, p_neg, p_basis, p_unit) c;
  SELECT COALESCE(SUM(amount),0), COALESCE(SUM(avg_qty),0) INTO tot, qty FROM aj_billing_line WHERE month = p_month AND kind IN ('시공팀','업체');
  UPDATE aj_billing_close SET total_amount = tot, total_qty = qty WHERE month = p_month;
  RETURN tot;
END $$;

REVOKE ALL ON FUNCTION aj_billing_calc(date, date, text, text, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION aj_billing_close_month(text, int, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION aj_billing_calc(date, date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION aj_billing_close_month(text, int, text, text, text) TO authenticated;
