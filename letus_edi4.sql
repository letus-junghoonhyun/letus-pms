-- ============================================================
-- LETUS PMS — EDI 정산 계산 함수 + 월 마감 확정(스냅샷)
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
-- ============================================================

-- 1) 정산 계산: 기간(from~to)의 작업장×제품별 사용 장수
--    사용 장수 = 일별 보유 수량 합계 ÷ 기간 일수(올림), 마이너스는 p_neg='zero'면 0으로 계산
--    p_basis: this(금일재고 전체) / cont(계약재고) / back(회수재고) / conf(확인재고)
CREATE OR REPLACE FUNCTION aj_billing_calc(p_from date, p_to date, p_neg text DEFAULT 'zero', p_basis text DEFAULT 'this')
RETURNS TABLE (workplace_no int, workplace_name text, kind text, item text, sum_qty bigint, avg_qty int, neg_days int, last_back int)
LANGUAGE sql STABLE AS $$
  WITH d AS (SELECT (p_to - p_from + 1)::numeric AS days),
  v AS (
    SELECT s.workplace_no, s.item, s.stoc_date,
      CASE p_basis
        WHEN 'cont' THEN COALESCE(NULLIF(s.raw->>'CONT_STOC','')::int, s.this_stoc)
        WHEN 'back' THEN COALESCE(NULLIF(s.raw->>'BACK_STOC','')::int, s.this_stoc)
        WHEN 'conf' THEN COALESCE(NULLIF(s.raw->>'CONF_STOC','')::int, s.this_stoc)
        ELSE s.this_stoc END AS q,
      NULLIF(s.raw->>'BACK_STOC','')::int AS back
    FROM aj_stock_daily s
    WHERE s.item <> '-' AND s.workplace_no <> 0 AND s.stoc_date BETWEEN p_from AND p_to
  )
  SELECT v.workplace_no, w.name, w.kind, v.item,
    SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END)::bigint,
    CEIL(SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END) / (SELECT days FROM d))::int,
    (COUNT(*) FILTER (WHERE v.q < 0))::int,
    (ARRAY_AGG(v.back ORDER BY v.stoc_date DESC))[1]
  FROM v JOIN aj_workplace w ON w.no = v.workplace_no
  GROUP BY v.workplace_no, w.name, w.kind, v.item
  HAVING SUM(CASE WHEN p_neg = 'zero' THEN GREATEST(v.q, 0) ELSE v.q END) <> 0
$$;

-- 2) 월 마감 스냅샷
CREATE TABLE IF NOT EXISTS aj_billing_close (
  month        TEXT PRIMARY KEY,        -- 정산월 'YYYY-MM' (전월 26일 ~ 당월 25일)
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  days         INT  NOT NULL,
  unit         INT  NOT NULL,           -- 장당 단가(원)
  neg_mode     TEXT NOT NULL,           -- zero / raw
  basis        TEXT NOT NULL,           -- this / cont / back / conf
  total_qty    BIGINT,                  -- 청구 대상(시공팀·업체) 사용 장수 합
  total_amount BIGINT,                  -- 청구 대상 금액 합
  note         TEXT,
  closed_by    TEXT,
  closed_at    TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aj_billing_line (
  id             BIGSERIAL PRIMARY KEY,
  month          TEXT NOT NULL REFERENCES aj_billing_close(month) ON DELETE CASCADE,
  workplace_no   INT NOT NULL,
  workplace_name TEXT,
  kind           TEXT,
  item           TEXT NOT NULL,
  sum_qty        BIGINT,
  avg_qty        INT,
  unit           INT,
  amount         BIGINT
);
CREATE INDEX IF NOT EXISTS aj_billing_line_month ON aj_billing_line (month, workplace_no);

ALTER TABLE aj_billing_close ENABLE ROW LEVEL SECURITY;
ALTER TABLE aj_billing_line  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajbc select" ON aj_billing_close;
CREATE POLICY "ajbc select" ON aj_billing_close FOR SELECT TO authenticated USING (my_role() IN ('관리자','정산담당','운송팀'));
DROP POLICY IF EXISTS "ajbl select" ON aj_billing_line;
CREATE POLICY "ajbl select" ON aj_billing_line FOR SELECT TO authenticated USING (my_role() IN ('관리자','정산담당','운송팀'));
-- 쓰기는 아래 함수(SECURITY DEFINER)로만

-- 3) 마감 확정: 25일까지 데이터가 들어와 있어야 하고, 이미 마감된 달은 다시 못 한다
CREATE OR REPLACE FUNCTION aj_billing_close_month(p_month text, p_unit int, p_neg text, p_basis text, p_note text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE y int; m int; f date; t date; tot bigint; qty bigint;
BEGIN
  IF COALESCE(my_role(), '') NOT IN ('관리자','정산담당') THEN RAISE EXCEPTION '마감 권한이 없어요'; END IF;
  IF EXISTS (SELECT 1 FROM aj_billing_close WHERE month = p_month) THEN RAISE EXCEPTION '이미 마감된 달이에요 (재오픈 후 다시 확정)'; END IF;
  y := split_part(p_month,'-',1)::int; m := split_part(p_month,'-',2)::int;
  f := make_date(y, m, 1) - interval '1 month' + interval '25 days';  -- 전월 26일
  t := make_date(y, m, 25);
  IF (SELECT MAX(stoc_date) FROM aj_stock_daily WHERE item <> '-') < t THEN
    RAISE EXCEPTION '재고 데이터가 % 까지 들어와야 마감할 수 있어요 (현재 %)', t, (SELECT MAX(stoc_date) FROM aj_stock_daily WHERE item <> '-');
  END IF;
  INSERT INTO aj_billing_close (month, period_from, period_to, days, unit, neg_mode, basis, note, closed_by)
    VALUES (p_month, f, t, (t - f + 1), p_unit, p_neg, p_basis, p_note, COALESCE((SELECT email FROM profiles WHERE id = auth.uid()), auth.uid()::text));
  INSERT INTO aj_billing_line (month, workplace_no, workplace_name, kind, item, sum_qty, avg_qty, unit, amount)
    SELECT p_month, c.workplace_no, c.workplace_name, c.kind, c.item, c.sum_qty, c.avg_qty, p_unit, c.avg_qty::bigint * p_unit
    FROM aj_billing_calc(f, t, p_neg, p_basis) c;
  SELECT COALESCE(SUM(amount),0), COALESCE(SUM(avg_qty),0) INTO tot, qty FROM aj_billing_line WHERE month = p_month AND kind IN ('시공팀','업체');
  UPDATE aj_billing_close SET total_amount = tot, total_qty = qty WHERE month = p_month;
  RETURN tot;
END $$;

-- 4) 재오픈(관리자만): 마감 취소
CREATE OR REPLACE FUNCTION aj_billing_reopen(p_month text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(my_role(), '') <> '관리자' THEN RAISE EXCEPTION '재오픈은 관리자만 할 수 있어요'; END IF;
  DELETE FROM aj_billing_close WHERE month = p_month;
END $$;

REVOKE ALL ON FUNCTION aj_billing_calc(date, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION aj_billing_close_month(text, int, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION aj_billing_reopen(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION aj_billing_calc(date, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION aj_billing_close_month(text, int, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION aj_billing_reopen(text) TO authenticated;
