-- ============================================================
-- LETUS PMS — 파렛트 현황 지도: 작업장 위치(주소 → 좌표) 저장
--  · 주소는 EDI 입고처 목록(aj_dest.addr)에서 가져오고, 화면에서 한 번 좌표로 바꿔 여기 저장한다
--  · 위치가 틀리면 지도에서 직접 옮겨 저장(src = '수동')
-- ============================================================
CREATE TABLE IF NOT EXISTS wp_geo (
  wp_no      INT PRIMARY KEY REFERENCES aj_workplace(no),
  addr       TEXT,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  src        TEXT,                 -- 카카오 / OSM / 수동 / 못찾음
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE wp_geo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wpgeo select" ON wp_geo;
CREATE POLICY "wpgeo select" ON wp_geo FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "wpgeo write" ON wp_geo;
CREATE POLICY "wpgeo write" ON wp_geo FOR ALL TO authenticated USING (is_internal()) WITH CHECK (is_internal());
NOTIFY pgrst, 'reload schema';
SELECT 'ok19' AS result;
