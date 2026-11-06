-- ============================================================
-- LETUS PMS — 파렛트 월마감
--  · closing_class : 계정·작업장마다 청구 분류(양지·지방센터·공장·일룸협력사·3PL 등). 한 번 정하면 계속 씀
--  · closing_month : 마감월별 입력값(ERP 매출·재고금액·11A 출고·AJ 세금계산서·AJ 구내용)과 확정 결과
--  · closing_gunae : 기간 구내용(매일 재고 합)을 계정·작업장·제품별로 서버에서 합산
-- ============================================================
CREATE TABLE IF NOT EXISTS closing_class (
  account    TEXT NOT NULL,
  wp_no      INT  NOT NULL,
  grp        TEXT NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account, wp_no)
);
CREATE TABLE IF NOT EXISTS closing_month (
  ym           TEXT PRIMARY KEY,          -- '2026-10' = 9/26 ~ 10/25
  inputs       JSONB DEFAULT '{}'::jsonb,
  result       JSONB,
  status       TEXT DEFAULT '작성중',      -- 작성중 / 확정
  confirmed_at TIMESTAMPTZ,
  confirmed_by TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE closing_class ENABLE ROW LEVEL SECURITY;
ALTER TABLE closing_month ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clc all" ON closing_class;
CREATE POLICY "clc all" ON closing_class FOR ALL TO authenticated USING (is_internal()) WITH CHECK (is_internal());
DROP POLICY IF EXISTS "clm all" ON closing_month;
CREATE POLICY "clm all" ON closing_month FOR ALL TO authenticated USING (is_internal()) WITH CHECK (is_internal());

CREATE OR REPLACE FUNCTION public.closing_gunae(p_from DATE, p_to DATE)
RETURNS TABLE(account TEXT, workplace_no INT, item TEXT, gunae BIGINT, gunae_pos BIGINT, days INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.account, s.workplace_no, s.item,
         SUM(s.this_stoc)::BIGINT,
         SUM(GREATEST(s.this_stoc, 0))::BIGINT,   -- 마이너스 날은 0으로 본 값(AJ 청구 비교용)
         COUNT(DISTINCT s.stoc_date)::INT
  FROM aj_stock_daily s
  WHERE is_internal() AND s.stoc_date BETWEEN p_from AND p_to AND s.item <> '-' AND s.workplace_no <> 0
  GROUP BY s.account, s.workplace_no, s.item;
$$;
GRANT EXECUTE ON FUNCTION public.closing_gunae(DATE, DATE) TO authenticated;
NOTIFY pgrst, 'reload schema';
SELECT 'ok20' AS result;
