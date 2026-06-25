-- ============================================================
-- LETUS PMS — AJ 연동(공급/회수 요청) + 재고 기반
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
--
-- aj_request: AJ에 보내는 요청
--   type='공급'  AJ → 우리 센터 (완료 시 센터 재고 +)
--   type='회수'  센터 또는 거래처 → AJ (완료 시 해당 위치 재고 −)
--   status: '요청' → '완료'
-- ============================================================

CREATE TABLE IF NOT EXISTS aj_request (
  id           UUID PRIMARY KEY,
  type         TEXT NOT NULL,                 -- 공급 / 회수
  pallet_code  TEXT NOT NULL,
  qty          INT  NOT NULL,
  center       TEXT,                          -- 공급 받는 센터 / 센터→AJ 회수 시 보내는 센터
  partner_code TEXT,                          -- 거래처→AJ 회수 시 그 거래처
  partner_name TEXT,
  status       TEXT NOT NULL DEFAULT '요청',  -- 요청 / 완료
  note         TEXT,
  created_by   UUID,
  requested_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE aj_request ENABLE ROW LEVEL SECURITY;

-- 내부(관리자·운송팀·정산담당) 조회 / 관리자·운송팀 쓰기
DROP POLICY IF EXISTS "aj select" ON aj_request;
CREATE POLICY "aj select" ON aj_request FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "aj insert" ON aj_request;
CREATE POLICY "aj insert" ON aj_request FOR INSERT TO authenticated WITH CHECK (my_role() IN ('관리자','운송팀'));
DROP POLICY IF EXISTS "aj update" ON aj_request;
CREATE POLICY "aj update" ON aj_request FOR UPDATE TO authenticated USING (my_role() IN ('관리자','운송팀')) WITH CHECK (my_role() IN ('관리자','운송팀'));
DROP POLICY IF EXISTS "aj delete" ON aj_request;
CREATE POLICY "aj delete" ON aj_request FOR DELETE TO authenticated USING (my_role() = '관리자');
