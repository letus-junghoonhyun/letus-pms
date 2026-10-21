-- ============================================================
-- LETUS PMS — EDI 계정 구분 (계정이 여러 개: 14C·18F / 일반유형 11A·15A / 15A 전용 / 23E 전용)
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
--  · 계정(account) = EDI 로그인 계정의 작업장코드(demdCode, 예: P156063)
--  · 작업장은 이름으로 하나의 "표준 작업장"(aj_workplace)에 합치고, 계정별 번호는 aj_workplace_map 으로 연결
-- ============================================================

-- 1) 계정 목록 (스크립트가 로그인할 때 자동 등록)
CREATE TABLE IF NOT EXISTS aj_account (
  code       TEXT PRIMARY KEY,          -- EDI 작업장코드 (demdCode)
  name       TEXT,                      -- EDI에 표시되는 이름 예: (주)레터스_15A 전용
  items      TEXT[],                    -- 이 계정에서 조회되는 제품코드
  label      TEXT,                      -- 사람이 알아볼 구분 (14C·18F / 일반유형(11A·15A) / 15A 전용 / 23E 전용)
  note       TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen  TIMESTAMPTZ
);
ALTER TABLE aj_account ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajac select" ON aj_account;
CREATE POLICY "ajac select" ON aj_account FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "ajac write" ON aj_account;
CREATE POLICY "ajac write" ON aj_account FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
INSERT INTO aj_account (code, name, items, label, note)
VALUES ('P156063', '(주)레터스(맵핑금지)', ARRAY['14C','18F'], '14C·18F', '최초 연동 계정')
ON CONFLICT (code) DO NOTHING;

-- 2) 데이터에 계정 구분 컬럼 (기존 데이터는 모두 최초 계정)
ALTER TABLE aj_stock_daily ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT 'P156063';
ALTER TABLE aj_move        ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT 'P156063';
ALTER TABLE aj_sync_log    ADD COLUMN IF NOT EXISTS account TEXT;
ALTER TABLE aj_invoice     ADD COLUMN IF NOT EXISTS account_code TEXT;   -- 임차료 명세서 ↔ 계정 연결(선택)

-- 3) 기본키/고유키에 계정 포함 (같은 제품 15A가 두 계정에 있어도 섞이지 않게)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aj_stock_daily_pkey' AND conrelid = 'aj_stock_daily'::regclass
             AND (SELECT count(*) FROM unnest(conkey)) = 3) THEN
    ALTER TABLE aj_stock_daily DROP CONSTRAINT aj_stock_daily_pkey;
    ALTER TABLE aj_stock_daily ADD PRIMARY KEY (account, stoc_date, workplace_no, item);
  END IF;
END $$;
DROP INDEX IF EXISTS aj_move_uq;
CREATE UNIQUE INDEX IF NOT EXISTS aj_move_uq2 ON aj_move (account, move_code, item, from_name, to_name, move_date);

-- 4) 계정별 작업장 번호 연결 + 계정별 마지막 수집일
CREATE TABLE IF NOT EXISTS aj_workplace_map (
  account      TEXT NOT NULL,
  local_no     INT  NOT NULL,           -- 그 계정에서의 작업장 번호(demdNumb). 0=모든작업장 합계
  wp_no        INT  NOT NULL REFERENCES aj_workplace(no),
  name         TEXT,
  sync_enabled BOOLEAN DEFAULT true,
  last_synced  DATE,
  PRIMARY KEY (account, local_no)
);
CREATE INDEX IF NOT EXISTS aj_wpmap_wp ON aj_workplace_map (wp_no);
ALTER TABLE aj_workplace_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajwm select" ON aj_workplace_map;
CREATE POLICY "ajwm select" ON aj_workplace_map FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "ajwm write" ON aj_workplace_map;
CREATE POLICY "ajwm write" ON aj_workplace_map FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
-- 기존 계정은 번호가 그대로 표준 번호
INSERT INTO aj_workplace_map (account, local_no, wp_no, name, sync_enabled, last_synced)
SELECT 'P156063', no, no, name, sync_enabled, last_synced FROM aj_workplace
ON CONFLICT (account, local_no) DO NOTHING;

-- 5) 정산 계산: 같은 작업장·제품이 여러 계정에 있으면 같은 날짜 보유량을 합산
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
  LEFT JOIN aj_cost_rate r ON r.code = g.itm;
END $$;
REVOKE ALL ON FUNCTION aj_billing_calc(date, date, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION aj_billing_calc(date, date, text, text, int) TO authenticated;
