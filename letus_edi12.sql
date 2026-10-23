-- ============================================================
-- LETUS PMS — EDI 납품기준수량 (최소 / 11톤) : 작업장·제품별
--  · EDI 납품요청/조회 화면을 열면 스크립트(v3.11)가 그 계정 작업장마다 읽어서 저장 (하루 1번)
--  · PMS AJ 공급요청 화면에서 [최소] [11톤] 버튼으로 수량 바로 입력
-- ============================================================
CREATE TABLE IF NOT EXISTS aj_item_min (
  account    TEXT NOT NULL,
  local_no   INT  NOT NULL,           -- 그 계정의 작업장 번호
  item       TEXT NOT NULL,           -- 14C / 18F …
  min1       INT,                     -- 최소 기준수량
  min2       INT,                     -- 11톤 기준수량
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account, local_no, item)
);
ALTER TABLE aj_item_min ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajim select" ON aj_item_min;
CREATE POLICY "ajim select" ON aj_item_min FOR SELECT TO authenticated USING (is_internal());
NOTIFY pgrst, 'reload schema';
SELECT 'ok' AS result, (SELECT count(*) FROM aj_item_min) AS rows;
