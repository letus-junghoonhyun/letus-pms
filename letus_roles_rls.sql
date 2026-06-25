-- ============================================================
-- LETUS PMS — 역할별 권한(RLS) 전면 재구축
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run 하세요.
-- 몇 번을 다시 돌려도 안전합니다(idempotent).
--
-- 역할: 관리자 / 운송팀 / 정산담당 / 협력업체
-- 핵심: 협력업체는 "본인 소속 거래처(partner)"로 온 건만 보이고,
--       단가(unit_price)는 내부 역할만 볼 수 있습니다.
-- ============================================================

-- ── 0) 협력업체 ↔ 거래처 연결용 컬럼 (없으면 추가) ──────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS partner_code TEXT;

-- ── 1) 현재 사용자의 역할/소속거래처를 돌려주는 헬퍼 함수 ──
--    security definer + 고정 search_path 로 RLS 재귀를 피합니다.
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM user_roles WHERE user_id = auth.uid() LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.my_partner()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT partner_code FROM profiles WHERE id = auth.uid() LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_internal()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_role() IN ('관리자','운송팀','정산담당')
$$;

-- ── 2) 대상 테이블의 기존 정책 전부 제거 (이름 무관) ────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'profiles','user_roles','pallet_type','unit_price','center',
        'partner','partner_pallet','vehicle','shipment','movement',
        'confirmation','return_request','billing_period','billing_line'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- RLS 활성화 보장
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','user_roles','pallet_type','unit_price','center',
    'partner','partner_pallet','vehicle','shipment','movement',
    'confirmation','return_request','billing_period','billing_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── 3) profiles: 본인 + 관리자 ───────────────────────────────
CREATE POLICY "profiles select" ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR my_role() = '관리자');
CREATE POLICY "profiles insert" ON profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid() OR my_role() = '관리자');
CREATE POLICY "profiles update" ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR my_role() = '관리자')
  WITH CHECK (id = auth.uid() OR my_role() = '관리자');

-- ── 4) user_roles: 본인 조회 + 관리자 전체 / 승격은 관리자만 ─
CREATE POLICY "roles select" ON user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR my_role() = '관리자');
-- 신규 가입자는 본인을 '협력업체'로만 자가등록 가능(관리자 승격 불가)
CREATE POLICY "roles insert" ON user_roles FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid() AND role = '협력업체') OR my_role() = '관리자');
CREATE POLICY "roles update" ON user_roles FOR UPDATE TO authenticated
  USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');

-- ── 5) pallet_type: 코드 정보(전원 조회) / 쓰기는 관리자 ────
CREATE POLICY "pallet select" ON pallet_type FOR SELECT TO authenticated USING (true);
CREATE POLICY "pallet write i" ON pallet_type FOR INSERT TO authenticated WITH CHECK (my_role() = '관리자');
CREATE POLICY "pallet write u" ON pallet_type FOR UPDATE TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');

-- ── 6) unit_price: 단가는 내부만 (협력업체 차단) ────────────
CREATE POLICY "price select" ON unit_price FOR SELECT TO authenticated USING (is_internal());
CREATE POLICY "price write i" ON unit_price FOR INSERT TO authenticated WITH CHECK (my_role() IN ('관리자','정산담당'));
CREATE POLICY "price write u" ON unit_price FOR UPDATE TO authenticated USING (my_role() IN ('관리자','정산담당')) WITH CHECK (my_role() IN ('관리자','정산담당'));

-- ── 7) partner: 내부 전체 / 협력업체는 본인 거래처만 ────────
CREATE POLICY "partner select" ON partner FOR SELECT TO authenticated
  USING (is_internal() OR (my_role() = '협력업체' AND code = my_partner()));
CREATE POLICY "partner write i" ON partner FOR INSERT TO authenticated WITH CHECK (my_role() IN ('관리자','운송팀'));
CREATE POLICY "partner write u" ON partner FOR UPDATE TO authenticated USING (my_role() IN ('관리자','운송팀')) WITH CHECK (my_role() IN ('관리자','운송팀'));

-- ── 8) shipment: 내부 전체 / 협력업체는 본인 거래처 건만 ────
CREATE POLICY "ship select" ON shipment FOR SELECT TO authenticated
  USING (is_internal() OR (my_role() = '협력업체' AND to_partner = my_partner()));
-- 출고 등록은 내부(관리자·운송팀)만
CREATE POLICY "ship insert" ON shipment FOR INSERT TO authenticated
  WITH CHECK (my_role() IN ('관리자','운송팀'));
-- 상태 변경: 내부 전체 / 협력업체는 본인 거래처의 '정방향(출고)' 건만(입고확인). 반납 입고확인은 센터(내부)만.
CREATE POLICY "ship update" ON shipment FOR UPDATE TO authenticated
  USING (my_role() IN ('관리자','운송팀') OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '출고'))
  WITH CHECK (my_role() IN ('관리자','운송팀') OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '출고'));

-- ── 9) movement: shipment과 동일 가시성 ─────────────────────
CREATE POLICY "mv select" ON movement FOR SELECT TO authenticated
  USING (is_internal() OR (my_role() = '협력업체' AND to_partner = my_partner()));
CREATE POLICY "mv insert" ON movement FOR INSERT TO authenticated
  WITH CHECK (my_role() IN ('관리자','운송팀') OR (my_role() = '협력업체' AND to_partner = my_partner()));
CREATE POLICY "mv update" ON movement FOR UPDATE TO authenticated
  USING (is_internal()) WITH CHECK (is_internal());

-- ── 10) 내부 전용 테이블들 (협력업체 접근 불가) ─────────────
--     center, vehicle, partner_pallet, confirmation, return_request
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['center','vehicle','partner_pallet','confirmation','return_request']
  LOOP
    EXECUTE format('CREATE POLICY "internal select" ON %I FOR SELECT TO authenticated USING (public.is_internal())', t);
    EXECUTE format('CREATE POLICY "internal insert" ON %I FOR INSERT TO authenticated WITH CHECK (public.my_role() IN (''관리자'',''운송팀''))', t);
    EXECUTE format('CREATE POLICY "internal update" ON %I FOR UPDATE TO authenticated USING (public.my_role() IN (''관리자'',''운송팀'')) WITH CHECK (public.my_role() IN (''관리자'',''운송팀''))', t);
  END LOOP;
END $$;

-- ── 11) 정산 테이블: 관리자·운송팀·정산담당 조회 / 쓰기는 관리자·정산담당
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_period','billing_line']
  LOOP
    EXECUTE format('CREATE POLICY "bill select" ON %I FOR SELECT TO authenticated USING (public.is_internal())', t);
    EXECUTE format('CREATE POLICY "bill insert" ON %I FOR INSERT TO authenticated WITH CHECK (public.my_role() IN (''관리자'',''정산담당''))', t);
    EXECUTE format('CREATE POLICY "bill update" ON %I FOR UPDATE TO authenticated USING (public.my_role() IN (''관리자'',''정산담당'')) WITH CHECK (public.my_role() IN (''관리자'',''정산담당''))', t);
  END LOOP;
END $$;

-- ============================================================
-- 끝. 이 스크립트는 letus_rls_writes.sql 을 완전히 대체합니다.
-- (이전 "auth insert/update" MVP 정책은 위 2)에서 모두 제거됨)
--
-- 첫 관리자 지정 예시 (본인 이메일로 바꿔 실행):
--   INSERT INTO user_roles (user_id, role)
--   SELECT id, '관리자' FROM auth.users WHERE email = '본인이메일@example.com'
--   ON CONFLICT (user_id) DO UPDATE SET role = '관리자';
-- ============================================================
