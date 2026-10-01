# EDI 재고 자동 동기화 설정

EDI 로그인에는 SMS 인증번호가 있어 서버가 대신 로그인할 수 없습니다.
그래서 **담당자가 EDI에 로그인하면 → 브라우저 스크립트가 자동 실행 → 어제까지 못 받은 날짜를 PMS로 전송**하는 방식입니다.

## 1회 설정 (관리자)

1. **DB**: Supabase SQL 편집기에서 `letus_edi.sql`, `letus_edi2.sql`(전체 합계·센터), `letus_edi3.sql`(건별 이동) 순서로 실행.
2. **수신 함수**: Supabase > Edge Functions > 새 함수 `edi-ingest` 생성, `supabase/functions/edi-ingest/index.ts` 내용 붙여넣기.
   - Verify JWT 는 **켠 채로 두기** (앱의 anon 키가 통과용, 실제 잠금은 토큰).
   - Edge Functions > Secrets 에 `EDI_INGEST_TOKEN` = 임의의 긴 문자열 등록.
3. **브라우저 스크립트**: Chrome/Edge에 Tampermonkey 설치 → 새 스크립트에 `tools/edi-sync.user.js` 붙여넣기.
   - EDI 메인 화면을 처음 열 때 함수 주소(`https://<프로젝트>.supabase.co/functions/v1/edi-ingest`), anon 키(`src/supabase.js`의 값), 토큰을 묻습니다. 브라우저에만 저장됩니다.
4. **대상 작업장**: PMS > EDI 재고·정산 에서 작업장을 고르고 “동기화 대상으로 지정” (관리자).

> 수신 함수 코드가 바뀌면(이동 동기화 추가 등) `supabase/functions/edi-ingest/index.ts` 내용으로 **다시 붙여넣고 Deploy** 해야 합니다.

## 매일 동작

EDI 로그인 → 메인 화면이 열리면 화면 오른쪽 아래에 진행 상태가 뜨고, 어제까지 반영되면 끝납니다.
(1시간 안에 다시 열면 건너뜁니다. 며칠 빠뜨려도 다음 접속 때 못 받은 날짜를 한꺼번에 채웁니다.)

## 동기화 대상

- 재고: `aj_workplace.sync_enabled = true` 인 작업장(현재 폐쇄 제외 전체). 처음 받는 작업장은 2026-09-26부터, 3곳씩 동시 조회.
- 이동: 모든작업장 건별 이동을 7일씩 조회 (최근 3일은 매번 다시 받아 수정·입고확인 변경 반영).
- 재고가 전혀 없는 작업장은 `item='-'` 빈 행으로 조회 표시만 남겨 다음부터 건너뜁니다.
- EDI 분석 노트는 `EDI_STUDY.md` 참고.

## 정산 계산

- 기간: 전월 26일 ~ 당월 25일 (공휴일 무관)
- 사용장수 = 일별 금일재고 합계 ÷ 일수(올림), 금액 = 사용장수 × 단가(기본 2,400원)
- 마이너스 재고는 화면에서 “0장으로 계산 / 음수 그대로” 선택 (AJ 실제 기준 확인 필요)
