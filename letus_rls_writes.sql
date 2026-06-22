-- ============================================================
-- LETUS PMS — 쓰기 권한(RLS) 추가
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요.
-- (이걸 안 하면 출고 등록·가입 등 "저장"이 막힙니다. 읽기만 허용된 상태라서요.)
-- 몇 번을 다시 돌려도 안전합니다.
-- ============================================================

-- 가입 시 본인 프로필/역할 생성 허용
DROP POLICY IF EXISTS "users insert own profile" ON profiles;
CREATE POLICY "users insert own profile"
  ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "users insert own role" ON user_roles;
CREATE POLICY "users insert own role"
  ON user_roles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND role = '협력업체');  -- 본인은 협력업체로만 자가등록(관리자 승격은 운영자가 SQL로)

-- 거래/마스터 테이블: 로그인 사용자 쓰기 허용 (MVP — 추후 역할별로 좁히기)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shipment','movement','confirmation','return_request',
    'billing_period','billing_line',
    'partner','partner_pallet','pallet_type','unit_price','center','vehicle'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth insert %1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "auth insert %1$s" ON %1$I FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS "auth update %1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "auth update %1$s" ON %1$I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
