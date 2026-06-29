-- ============================================================
-- LETUS PMS — 현장 사진 증빙 + 출고 묶음(전표용)
-- Supabase 대시보드 > SQL 편집기에 붙여넣고 Run. (여러 번 안전)
-- ============================================================

-- 출고 묶음(한 차량/한 전표 단위로 여러 유형 행을 묶음) + 사진 URL
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS batch_id   uuid;
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS out_photos text[];  -- 출고 현장 사진
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS in_photos  text[];  -- 입고확인 사진

-- 사진 저장 버킷 (공개 읽기)
INSERT INTO storage.buckets (id, name, public)
VALUES ('pallet-photos', 'pallet-photos', true)
ON CONFLICT (id) DO NOTHING;

-- 버킷 접근 정책: 누구나 읽기, 로그인 사용자 업로드
DROP POLICY IF EXISTS "pallet photos read" ON storage.objects;
CREATE POLICY "pallet photos read" ON storage.objects
  FOR SELECT USING (bucket_id = 'pallet-photos');
DROP POLICY IF EXISTS "pallet photos write" ON storage.objects;
CREATE POLICY "pallet photos write" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'pallet-photos');
