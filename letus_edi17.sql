-- ============================================================
-- LETUS PMS — AJ 공급 매칭·확인
--  · 매칭 규칙(검증: 10/01~ 렌탈입고 47줄 전부 1:1): 같은 계정 + 받는 작업장 + 제품 + 렌탈입고일 = 납품요청 희망일
--  · aj_call_decision: AJ가 덜 보냈을 때 관리자 결정(남은 수량 재요청 / 이대로 종결)
--  · edi_fix: AJ 공급(D코드)·회수(S코드) 상이는 우리가 EDI에서 못 고치므로 AJ 수정요청 게시판으로 → 문구·요청번호 저장
-- ============================================================
CREATE TABLE IF NOT EXISTS aj_call_decision (
  account     TEXT NOT NULL,
  call_code   TEXT NOT NULL,
  item        TEXT NOT NULL,
  decision    TEXT NOT NULL,            -- 재요청 / 종결
  note        TEXT,
  decided_by  UUID DEFAULT auth.uid(),
  decided_name TEXT,
  decided_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account, call_code, item)
);
ALTER TABLE aj_call_decision ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ajcd select" ON aj_call_decision;
CREATE POLICY "ajcd select" ON aj_call_decision FOR SELECT TO authenticated USING (is_internal());
DROP POLICY IF EXISTS "ajcd write" ON aj_call_decision;
CREATE POLICY "ajcd write" ON aj_call_decision FOR ALL TO authenticated USING (my_role() IN ('관리자','운송팀')) WITH CHECK (my_role() IN ('관리자','운송팀'));

ALTER TABLE edi_fix ADD COLUMN IF NOT EXISTS aj_text       TEXT;   -- AJ 수정요청 게시판에 올릴 문구
ALTER TABLE edi_fix ADD COLUMN IF NOT EXISTS aj_rqst_code  TEXT;   -- 게시판 저장 후 받은 요청번호
ALTER TABLE edi_fix ADD COLUMN IF NOT EXISTS aj_sent_at    TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
SELECT 'ok17' AS result;
