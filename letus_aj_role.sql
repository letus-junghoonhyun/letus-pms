-- ============================================================
-- LETUS PMS — AJ네트웍스 직원 역할 + 협력업체 AJ회수 등록
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
--
-- 역할 'AJ' = AJ네트웍스 직원: 요청 조회 + 완료 처리만.
-- 협력업체: 본인 거래처의 '회수' 요청(AJ로 회수)을 직접 등록 가능.
-- ============================================================

DROP POLICY IF EXISTS "aj select" ON aj_request;
CREATE POLICY "aj select" ON aj_request FOR SELECT TO authenticated
  USING (is_internal() OR my_role() = 'AJ' OR (my_role() = '협력업체' AND partner_code = my_partner()));

DROP POLICY IF EXISTS "aj insert" ON aj_request;
CREATE POLICY "aj insert" ON aj_request FOR INSERT TO authenticated
  WITH CHECK (
    my_role() IN ('관리자','운송팀')
    OR (my_role() = '협력업체' AND type = '회수' AND partner_code = my_partner())
  );

DROP POLICY IF EXISTS "aj update" ON aj_request;
CREATE POLICY "aj update" ON aj_request FOR UPDATE TO authenticated
  USING (my_role() IN ('관리자','운송팀','AJ')) WITH CHECK (my_role() IN ('관리자','운송팀','AJ'));

-- 참고: 'AJ' 역할 지정은 관리자가 사용자 관리 화면에서 변경하면 됩니다.
--   (또는 SQL: UPDATE user_roles SET role='AJ' WHERE user_id = (SELECT id FROM auth.users WHERE email='aj직원@...'); )
