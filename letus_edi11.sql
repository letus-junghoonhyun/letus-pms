-- ============================================================
-- LETUS PMS — AJ 공급요청 → EDI 납품요청/조회 자동입력
--  · PMS AJ 요청(공급)에 EDI 납품요청 항목(받는 작업장·희망일·시간·배차·톤수·차량·연락처)을 같이 저장
--  · EDI 납품요청/조회 화면(OTHR_SIGN_LIST.do)에서 스크립트(v3.8)가 [채우기] → 사람이 [등록]
--  · 등록되면 EDI 응답을 edi_call_code 에 남기고 edi_status = '등록'
-- ============================================================
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS wp_no         INT;   -- 받는(보내는) EDI 작업장
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS want_date     DATE;  -- 희망일
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS want_time     TEXT;  -- 오전 / 오후
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS cars_oper     TEXT;  -- 01 AJ배차 / 03 내방
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS cars_tons     TEXT;  -- 01~06 (통행가능 최대 톤수)
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS cars_type     TEXT;  -- 00 상관없음 / 01 윙바디 / 02 카고
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS phone         TEXT;  -- 현장 연락처
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS edi_group     TEXT;  -- 한 번에 요청한 묶음 (EDI 1건)
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS edi_account   TEXT;  -- EDI 계정 (제품으로 결정)
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS edi_local     INT;   -- 그 계정의 작업장 번호
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS edi_status    TEXT;  -- 대기 / 등록 / 취소 (NULL = EDI 안 씀)
ALTER TABLE aj_request ADD COLUMN IF NOT EXISTS edi_call_code TEXT;  -- EDI 등록 응답
CREATE INDEX IF NOT EXISTS aj_request_edi ON aj_request (edi_account, edi_status);
SELECT 'ok' AS result;
