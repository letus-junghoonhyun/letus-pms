-- ============================================================
-- LETUS PMS — (테스트용) 데이터 초기화 권한
-- 관리자가 shipment/movement 를 삭제할 수 있게 DELETE 정책 추가.
-- 운영 전환 시 이 정책은 제거하세요(아래 DROP만 실행).
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

DROP POLICY IF EXISTS "ship delete" ON shipment;
CREATE POLICY "ship delete" ON shipment FOR DELETE TO authenticated USING (my_role() = '관리자');

DROP POLICY IF EXISTS "mv delete" ON movement;
CREATE POLICY "mv delete" ON movement FOR DELETE TO authenticated USING (my_role() = '관리자');

-- 운영 전환 시(초기화 기능 제거할 때) 아래 두 줄만 실행:
--   DROP POLICY IF EXISTS "ship delete" ON shipment;
--   DROP POLICY IF EXISTS "mv delete" ON movement;
