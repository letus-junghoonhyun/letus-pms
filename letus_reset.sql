-- ============================================================
-- LETUS PMS — (테스트용) 데이터 초기화 권한
-- 관리자가 shipment/movement 를 삭제할 수 있게 DELETE 정책 추가.
-- 운영 전환 시 이 정책은 제거하세요(아래 DROP만 실행).
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

-- shipment + 이를 참조하는 자식 테이블(movement/confirmation/return_request) 삭제 허용
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipment','movement','confirmation','return_request']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "admin delete %1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "admin delete %1$s" ON %1$I FOR DELETE TO authenticated USING (public.my_role() = ''관리자'')', t);
  END LOOP;
END $$;

-- 운영 전환 시(초기화 기능 제거할 때) 아래 두 줄만 실행:
--   DROP POLICY IF EXISTS "ship delete" ON shipment;
--   DROP POLICY IF EXISTS "mv delete" ON movement;
