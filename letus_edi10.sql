-- ============================================================
-- LETUS PMS — 출발지·도착지 자유 지정 (EDI 작업장 기준)
--  · 출고 등록의 "작업장 간" 방향: 아무 작업장 → 아무 작업장
--  · from_wp / to_wp = aj_workplace.no. 있으면 EDI 반영·재고현황이 이 값을 우선 사용한다
--  · 센터·거래처로 연결된 작업장이면 기존 칸(center/to_partner/to_center)도 함께 채워 기존 화면과 호환
-- ============================================================
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS from_wp   INT;
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS to_wp     INT;
ALTER TABLE shipment ADD COLUMN IF NOT EXISTS from_name TEXT;
CREATE INDEX IF NOT EXISTS shipment_from_wp ON shipment (from_wp);
CREATE INDEX IF NOT EXISTS shipment_to_wp   ON shipment (to_wp);
SELECT 'ok' AS result;
