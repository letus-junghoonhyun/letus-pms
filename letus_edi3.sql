-- ============================================================
-- LETUS PMS — EDI 건별 이동(거래처 입출고 조회) 저장
-- Supabase SQL 편집기에서 Run. (여러 번 안전)
-- ============================================================

-- 이동 1건 = 이동코드 × 제품 × 출발지 × 도착지 (수정·입고확인 상태는 다시 받을 때 갱신)
CREATE TABLE IF NOT EXISTS aj_move (
  id         BIGSERIAL PRIMARY KEY,
  move_code  TEXT NOT NULL,              -- 이동코드 (M26I…)
  move_date  DATE NOT NULL,              -- 이동일자
  item       TEXT NOT NULL,              -- 14C / 18F …
  from_name  TEXT NOT NULL,              -- 출발지
  to_name    TEXT NOT NULL,              -- 도착지
  move_type  TEXT,                       -- 이동출고 / 반납출고 / 렌탈입고 / 회수출고 …
  iner       TEXT,                       -- 내부(센터·사업장 간) / 외부(수요처 간)
  qty        INT  NOT NULL,              -- 수량 (정정 건은 음수)
  chng       TEXT,                       -- 신규 / 수정
  conf       TEXT,                       -- 입고확인: 미확인 / 승인 …
  retn       TEXT,                       -- 반납확인
  bill_no    TEXT,                       -- 전표번호
  note       TEXT,                       -- 비고
  synced_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS aj_move_uq ON aj_move (move_code, item, from_name, to_name, move_date);
CREATE INDEX IF NOT EXISTS aj_move_date ON aj_move (move_date);
CREATE INDEX IF NOT EXISTS aj_move_from ON aj_move (from_name, move_date);
CREATE INDEX IF NOT EXISTS aj_move_to   ON aj_move (to_name, move_date);

ALTER TABLE aj_move ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajmv select" ON aj_move;
CREATE POLICY "ajmv select" ON aj_move FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "ajmv write" ON aj_move;
CREATE POLICY "ajmv write" ON aj_move FOR ALL TO authenticated USING (my_role() = '관리자') WITH CHECK (my_role() = '관리자');
