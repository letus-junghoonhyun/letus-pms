-- ============================================================
-- letus_perm.sql — 권한 구조 개편 (2026-11-08)
--  · 역할 추가: 센터작업자, 업체(향후)   ※ '협력업체' 값은 화면에서 '시공팀'으로 표시
--  · 계정별 권한 켜기/끄기: profiles.perms (jsonb, 역할 기본값 위에 덮어씀)
--  · 승인 상태: profiles.status ('승인' / '대기') — 대기·비활성 계정은 my_role()이 NULL → 모든 데이터 차단
--  · 센터작업자는 배정 센터(profiles.center_codes) 건만 등록·처리
-- Supabase SQL Editor에서 한 번 실행
-- ============================================================

-- 1) 컬럼
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS perms  JSONB DEFAULT '{}'::jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status TEXT;
UPDATE profiles SET status = '승인' WHERE status IS NULL;          -- 기존 계정은 모두 승인
ALTER TABLE profiles ALTER COLUMN status SET DEFAULT '대기';        -- 새 가입자는 승인 대기
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS emp_id TEXT;          -- EP 아이디(내부 직원) / 휴대폰 번호(시공팀)

-- 2) 역할 값
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('관리자','운송팀','센터작업자','정산담당','협력업체','업체','AJ'));

-- 3) 내 역할: 비활성·승인대기면 NULL (모든 정책이 my_role()을 쓰므로 한 번에 차단)
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.role FROM user_roles r
  LEFT JOIN profiles p ON p.id = r.user_id
  WHERE r.user_id = auth.uid()
    AND COALESCE(p.active, true)
    AND COALESCE(p.status, '승인') = '승인'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_internal()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.my_role() IN ('관리자','운송팀','센터작업자','정산담당')
$$;

-- 4) 권한: 역할 기본값 → 계정별 덮어쓰기(perms->>key = 'true'/'false')
--    키: outbound(출고 등록) receive(입고 확인) ajRequest(AJ 요청) inventory(재고 조회) edi(EDI) master(거래처) closing(마감) price(단가) users(사용자)
CREATE OR REPLACE FUNCTION public.role_perm_default(r TEXT, k TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r = '관리자' THEN true
    WHEN r = '운송팀' THEN k IN ('outbound','receive','ajRequest','inventory','edi','master')
    WHEN r = '센터작업자' THEN k IN ('outbound','receive','inventory')
    WHEN r = '정산담당' THEN k IN ('inventory','edi','closing','price')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.my_perm(k TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.my_role() IS NULL THEN false
    WHEN public.my_role() = '관리자' THEN true            -- 관리자는 끌 수 없음(잠김 방지)
    ELSE COALESCE((SELECT (p.perms ->> k)::boolean FROM profiles p WHERE p.id = auth.uid()), public.role_perm_default(public.my_role(), k))
  END
$$;

-- 센터 범위: 센터작업자는 배정 센터만(미배정 = 아무 센터도 아님), 그 외 내부 역할은 전체
CREATE OR REPLACE FUNCTION public.my_center_ok(c TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.my_role() <> '센터작업자' THEN true
    ELSE c = ANY (COALESCE((SELECT center_codes FROM profiles WHERE id = auth.uid()), '{}'))
  END
$$;

-- 5) 출고(shipment)
DROP POLICY IF EXISTS "ship insert" ON shipment;
CREATE POLICY "ship insert" ON shipment FOR INSERT TO authenticated
  WITH CHECK (
    (public.my_perm('outbound') AND (public.my_center_ok(center) OR public.my_center_ok(to_center)))
    OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '반납')
    OR (my_role() = '협력업체' AND from_wp IN (SELECT no FROM aj_workplace WHERE partner_code = my_partner()))
  );
DROP POLICY IF EXISTS "ship update" ON shipment;
CREATE POLICY "ship update" ON shipment FOR UPDATE TO authenticated
  USING (
    ((public.my_perm('outbound') OR public.my_perm('receive')) AND (public.my_center_ok(center) OR public.my_center_ok(to_center)))
    OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '출고')
  )
  WITH CHECK (
    ((public.my_perm('outbound') OR public.my_perm('receive')) AND (public.my_center_ok(center) OR public.my_center_ok(to_center)))
    OR (my_role() = '협력업체' AND to_partner = my_partner() AND direction = '출고')
  );

DROP POLICY IF EXISTS "mv insert" ON movement;
CREATE POLICY "mv insert" ON movement FOR INSERT TO authenticated
  WITH CHECK (public.my_perm('outbound') OR public.my_perm('receive') OR my_role() = '협력업체');

-- 6) AJ 요청
DROP POLICY IF EXISTS "aj insert" ON aj_request;
CREATE POLICY "aj insert" ON aj_request FOR INSERT TO authenticated
  WITH CHECK (
    public.my_perm('ajRequest')
    OR (my_role() = '협력업체' AND type = '회수' AND partner_code = my_partner())
  );
DROP POLICY IF EXISTS "aj update" ON aj_request;
CREATE POLICY "aj update" ON aj_request FOR UPDATE TO authenticated
  USING (public.my_perm('ajRequest') OR public.my_perm('receive') OR my_role() = 'AJ')
  WITH CHECK (public.my_perm('ajRequest') OR public.my_perm('receive') OR my_role() = 'AJ');

-- 7) 내부 처리 테이블(입고확인·반납요청 등)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['confirmation','return_request']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "internal insert" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "internal update" ON %I', t);
    EXECUTE format('CREATE POLICY "internal insert" ON %I FOR INSERT TO authenticated WITH CHECK (public.my_perm(''outbound'') OR public.my_perm(''receive''))', t);
    EXECUTE format('CREATE POLICY "internal update" ON %I FOR UPDATE TO authenticated USING (public.my_perm(''outbound'') OR public.my_perm(''receive'')) WITH CHECK (public.my_perm(''outbound'') OR public.my_perm(''receive''))', t);
  END LOOP;
END $$;

-- 8) 본인은 이름·연락처만 고칠 수 있고 역할·권한·상태는 관리자만
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.my_role() IS DISTINCT FROM '관리자' THEN
    NEW.perms := OLD.perms; NEW.status := OLD.status; NEW.active := OLD.active;
    NEW.center_codes := OLD.center_codes; NEW.partner_code := OLD.partner_code;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_guard ON profiles;
CREATE TRIGGER profiles_guard BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();

NOTIFY pgrst, 'reload schema';
SELECT 'perm ok' AS result;
