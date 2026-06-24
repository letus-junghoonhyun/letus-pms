-- ============================================================
-- LETUS PMS — 반납(역방향) 수불 기능
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요. (여러 번 안전)
--
-- direction: '출고'(우리→거래처, 기본) / '반납'(거래처→우리)
-- 협력업체가 본인 거래처 명의로 '반납' 출고를 등록할 수 있게 허용.
-- ============================================================

-- 1) 방향 컬럼 (기존 행은 전부 '출고'로)
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT '출고';
ALTER TABLE movement ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT '출고';

-- 2) shipment INSERT 정책 재작성:
--    내부(관리자·운송팀)는 전체 / 협력업체는 본인 거래처의 '반납'만
DROP POLICY IF EXISTS "ship insert" ON shipment;
CREATE POLICY "ship insert" ON shipment FOR INSERT TO authenticated
  WITH CHECK (
    my_role() IN ('관리자','운송팀')
    OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '반납')
  );
