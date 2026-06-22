# LETUS PMS — 파렛트 렌탈 수불관리 시스템

Fursys 운송사업팀 파렛트 관리 플랫폼. React + Supabase + Vercel(PWA).

## 화면
- 수불 현황 / 출고 등록 / 입고확인 / 회수 관리 / 정산 / 거래처·단가 / 사용자 관리

## 역할
관리자 · 운송팀 · 정산담당 · 협력업체 (협력업체는 본인 소속 거래처 건만 조회·입고확인)

## 로컬 개발
```bash
npm install
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
```

## 배포 시 Supabase에서 실행할 SQL (순서대로)
1. `letus_roles_rls.sql` — 역할별 권한(RLS)
2. `letus_improvements.sql` — shipment.note / canceled 컬럼 추가

## 구조
- `src/App.jsx` — 전체 앱 (화면 + 인증 + 로직)
- `src/supabase.js` — Supabase 연결 (anon key, 공개 가능)
- `public/` — PWA 매니페스트·아이콘
