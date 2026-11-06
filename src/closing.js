// 파렛트 월마감 계산 엔진 (화면과 분리된 순수 함수)
// 입력: 작업장별 구내용 + 청구 분류(group), ERP 매출 9개, 시디즈 음성창고 재고금액, 11A 출고수량, AJ 세금계산서 금액
// 출력: 브랜드 × 내수/해외(온라인) 이용료 표, 임대료 전표, 임차료 전표
// 규칙은 2026-08 월마감 엑셀(요약및변환·경인지방해외비율·☆청구☆)과 원 단위까지 같게 맞췄다.

export const CLOSING_DEFAULTS = {
  rentPrice: 2400,        // 브랜드 청구 단가 (월평균 1장당)
  price11A: 13200,        // 11A·15A
  price23E: 7000,
  sidizUnit: 881485,      // 양지센터 시디즈 몫 = 시디즈 음성창고 재고금액 ÷ 이 값 (품의 바로스-품의17-07-00042)
  sidizFactory: { 시디즈: 0.64, 퍼시스: 0.266, 일룸: 0.094 }, // 시디즈 평택·안성 공장 사용량 나누기
  leaseSplit: { 퍼시스: 0.39, 일룸: 0.473, 시디즈: 0.137 },   // AJ 임차료(브랜드 몫) 나누기
};
// 지방센터(퍼시스·일룸·시디즈가 지방 내수 매출 비율로 나눔)
export const LOCAL_CENTERS = ["강원", "대전", "대구", "부산", "울산", "전남", "창원", "광주", "전북", "제주"];
// 청구 분류 이름(작업장 하나에 하나). 3PL·기타는 브랜드 청구에서 빠짐
export const CLOSING_GROUPS = ["양지", "양지2", "3PL", ...LOCAL_CENTERS, "침대사업부", "안성공장", "충주1", "충주2", "일룸협력사", "시디즈공장", "시디즈기타", "기타", "11A", "15A", "23E"];

const INT = (x) => Math.floor(x + 1e-9);
const roundHalfUp = (x) => Math.floor(x + 0.5);

// 비율 (경인지방해외비율 시트)
export function closingRatios(erp, out11A) {
  const r = {};
  for (const b of ["퍼시스", "일룸", "시디즈"]) {
    const e = erp[b], t = e.경인 + e.수출;
    r[b] = { dom: e.경인 / t, exp: e.수출 / t }; // 양지센터용: 경인 내수 : 해외
  }
  const fa = { dom: 0, exp: 0 }; // 안성·충주 공장: (퍼시스+일룸) (경인+지방) : 수출
  for (const b of ["퍼시스", "일룸"]) { fa.dom += erp[b].경인 + erp[b].지방; fa.exp += erp[b].수출; }
  r.factory = { dom: fa.dom / (fa.dom + fa.exp), exp: fa.exp / (fa.dom + fa.exp) };
  const localSum = erp.퍼시스.지방 + erp.일룸.지방 + erp.시디즈.지방; // 지방센터: 지방 내수 비중
  r.local = { 퍼시스: erp.퍼시스.지방 / localSum, 일룸: erp.일룸.지방 / localSum, 시디즈: erp.시디즈.지방 / localSum };
  const o = (out11A.일룸 || 0) + (out11A.시디즈 || 0);
  r.r11A = { 일룸: o ? out11A.일룸 / o : 0, 시디즈: o ? out11A.시디즈 / o : 0 };
  return r;
}

// rows: [{ name, group, gunae }]  (gunae = 구내용)
// opts.excludeFromSubtotal: 엑셀 재현용 — 소계 수식에서 빠져 있던 작업장 이름들
export function computeClosing({ rows, days, erp, sidizStockAmt, out11A, cfg = {}, opts = {} }) {
  const C = { ...CLOSING_DEFAULTS, ...cfg };
  const R = closingRatios(erp, out11A);
  const avgOf = (g) => Math.ceil(g / days - 1e-9); // 월평균 = 구내용 ÷ 일수 올림
  const ex = new Set(opts.excludeFromSubtotal || []);
  const lines = rows.map((r) => ({ ...r, avg: avgOf(r.gunae || 0) }));
  const G = {}; lines.forEach((l) => { if (!ex.has(l.name)) G[l.group] = (G[l.group] || 0) + l.avg; });
  const g = (k) => G[k] || 0;

  const out = []; // { brand, place, dom, exp, note }
  const push = (brand, place, dom, exp = 0, note) => out.push({ brand, place, dom, exp, note });
  const split = (D, rt) => { const i = INT(D * rt.dom), k = INT(D * rt.exp), o = INT(D - (i + k)); return { dom: i + o, exp: k }; };

  // 시디즈 몫(양지센터) = 재고금액 ÷ 기준단가
  const sidizYangji = Math.ceil(sidizStockAmt / C.sidizUnit - 1e-9);
  // 시디즈 평택·안성 공장 (+ 음성·협력사 보정)
  const D82 = g("시디즈공장"), base82 = INT(D82 * R.시디즈.dom);
  const O43 = INT(base82 * C.sidizFactory.퍼시스), O44 = INT(base82 * C.sidizFactory.일룸);
  const I82 = INT(base82 * C.sidizFactory.시디즈), K82 = INT(D82 * R.시디즈.exp);
  const O81 = INT(D82 * C.sidizFactory.시디즈) + INT(D82 * C.sidizFactory.퍼시스) + INT(D82 * C.sidizFactory.일룸);
  const K457 = g("시디즈공장") + g("시디즈기타") - D82 + 1;
  const O82 = D82 - O81 + K457;

  // 퍼시스: 안성공장·충주1·충주2
  for (const k of ["안성공장", "충주1", "충주2"]) { const s = split(g(k), R.factory); push("퍼시스", k, s.dom, s.exp); }
  // 양지센터: 절반 퍼시스, 나머지 일룸(일룸 협력사·양지2 포함)
  const D25 = g("양지") - sidizYangji, D39 = g("일룸협력사") + g("양지2");
  const I25 = INT(D25 / 2 * R.퍼시스.dom), K25 = INT(D25 / 2 * R.퍼시스.exp);
  const rest = D39 + D25 - I25 - K25;
  const I39 = INT(rest * R.일룸.dom), K39 = INT(rest * R.일룸.exp);
  const O25 = INT((D25 + D39) - (I25 + K25 + I39 + K39));
  push("퍼시스", "양지센터", I25 + O25 + O43, K25);
  // 지방센터
  const local = {};
  for (const c of LOCAL_CENTERS) {
    const D = g(c), ip = INT(D * R.local.퍼시스), ii = INT(D * R.local.일룸), is = INT(D * R.local.시디즈), o = INT(D - (ip + ii + is));
    local[c] = { 퍼시스: ip + o, 일룸: ii, 시디즈: is };
    push("퍼시스", c + "센터", ip + o, 0);
  }
  push("일룸", "양지센터", I39 + O44, K39);
  push("일룸", "침대사업부", g("침대사업부"), 0);
  for (const c of LOCAL_CENTERS) push("일룸", c + "센터", local[c].일룸, 0);
  push("시디즈", "평택공장·안성공장", I82 + O82, K82);
  { const i = INT(sidizYangji * R.시디즈.dom), k = INT(sidizYangji * R.시디즈.exp), o = INT(sidizYangji - (i + k)); push("시디즈", "양지센터", i + o, k); }
  for (const c of LOCAL_CENTERS) push("시디즈", c + "센터", local[c].시디즈, 0);

  // 11A(쿠팡): 출고 비율, 나머지는 큰 쪽에
  const D104 = g("11A"), i1 = INT(D104 * R.r11A.일룸), i2 = INT(D104 * R.r11A.시디즈), o1 = INT(D104 - i1 - i2);
  const a11 = { 일룸: i1 >= i2 ? i1 + o1 : i1, 시디즈: i2 > i1 ? i2 + o1 : i2 };
  const q15A = g("15A"), q23E = g("23E");

  // 브랜드 합계
  const sum = (b, f) => out.filter((x) => x.brand === b).reduce((a, x) => a + x[f], 0);
  const bills = {};
  for (const b of ["퍼시스", "일룸", "시디즈"]) bills[b] = { 내수: sum(b, "dom") * C.rentPrice, 해외: sum(b, "exp") * C.rentPrice, 온라인: 0, domQty: sum(b, "dom"), expQty: sum(b, "exp") };
  bills.일룸.내수 += q23E * C.price23E;
  bills.일룸.온라인 = a11.일룸 * C.price11A;
  bills.시디즈.온라인 = a11.시디즈 * C.price11A + q15A * C.price11A;

  return { ratios: R, avgByGroup: G, lines, table: out, a11, q15A, q23E, sidizYangji, bills, cfg: C };
}

// 임대료 전표 (우리 → 브랜드). 금액은 원 단위 정수
export const BRAND_PARTNER = {
  퍼시스: { code: "B07435", name: "(주)퍼시스", biz: "215-81-20534", cc: "퍼시스PLT" },
  일룸: { code: "B02268", name: "(주)일룸", biz: "215-86-93600", cc: "일룸PLT" },
  시디즈: { code: "T01TSE", name: "(주)시디즈평택(구 팀스)", biz: "215-87-48121", cc: "시디즈PLT" },
};
export function rentVoucher(bills, ym) {
  const L = [];
  const label = (b, k) => `${ym} 파렛트 임대료(${b}_${k})`;
  for (const b of ["퍼시스", "일룸", "시디즈"]) for (const k of ["내수", "온라인", "해외"]) {
    const amt = bills[b][k]; if (!amt) continue;
    L.push({ acct: "외상매출금1", memo: label(b, k), partner: BRAND_PARTNER[b], debit: Math.round(amt * 1.1), credit: 0 });
  }
  for (const b of ["퍼시스", "일룸", "시디즈"]) {
    const supply = bills[b].내수 + bills[b].온라인 + bills[b].해외;
    L.push({ acct: "용역수입", memo: `${ym} 파렛트 임대료(${b})`, cc: BRAND_PARTNER[b].cc, debit: 0, credit: supply });
  }
  for (const b of ["퍼시스", "일룸", "시디즈"]) {
    const supply = bills[b].내수 + bills[b].온라인 + bills[b].해외;
    L.push({ acct: "예수부가세", memo: `${ym} 파렛트 임대료(${b})부가세`, partner: BRAND_PARTNER[b], supply, debit: 0, credit: Math.round(supply * 0.1) });
  }
  // 외상매출금(부가세 포함)을 줄마다 반올림하면 합이 몇 원 어긋날 수 있어 차이는 용역수입 마지막 줄에서 맞춘다
  const d = L.reduce((a, x) => a + x.debit, 0), c = L.reduce((a, x) => a + x.credit, 0);
  if (d !== c) { const last = L.filter((x) => x.acct === "용역수입").pop(); last.credit += d - c; last.adjusted = d - c; }
  return L;
}

// 임차료 전표 (AJ → 우리). invoices: AJ 세금계산서 공급가 { "18F,14C", "11A", "23E", "15A", "풀필먼트23E" }
// thirdParty: 18F·14C 계산서 안에 있는 3PL 고객 몫 { 블링크프로젝트, 네오스코리아, 에이스침대중부공장 }
export const AJ_PARTNER = { code: "B07731", name: "AJ네트웍스 주식회사", biz: "214-86-48586" };
export function leaseVoucher(invoices, thirdParty, ym, split = CLOSING_DEFAULTS.leaseSplit) {
  const total = Object.values(invoices).reduce((a, x) => a + x, 0);
  const tp = Object.values(thirdParty).reduce((a, x) => a + x, 0);
  const pool = total - (invoices["15A"] || 0) - (invoices["풀필먼트23E"] || 0) - tp;
  const L = [];
  const brand = {};
  for (const b of ["일룸", "퍼시스", "시디즈"]) brand[b] = roundHalfUp(pool * split[b]);
  const diff = pool - Object.values(brand).reduce((a, x) => a + x, 0); brand.일룸 += diff; // 반올림 차이는 일룸에
  for (const b of ["일룸", "퍼시스", "시디즈"]) L.push({ acct: "(용)임차료", memo: `${ym} 파렛트 임차료(${b})`, cc: BRAND_PARTNER[b].cc, debit: brand[b], credit: 0 });
  if (invoices["15A"]) L.push({ acct: "(용)임차료", memo: `${ym} 파렛트 임차료 (15A)`, cc: "풀필먼트 OUTSITE물류", debit: invoices["15A"], credit: 0 });
  if (invoices["풀필먼트23E"]) L.push({ acct: "(용)임차료", memo: `${ym} 파렛트 임차료 풀필먼트23E`, cc: "풀필먼트양지3 물류(공통)", debit: invoices["풀필먼트23E"], credit: 0 });
  for (const [k, v] of Object.entries(thirdParty)) if (v) L.push({ acct: "(용)임차료", memo: `${ym} 파렛트 임차료(${k})`, cc: "풀필먼트양지3 물류(공통)", debit: v, credit: 0 });
  let vatSum = 0;
  for (const [k, v] of Object.entries(invoices)) {
    const vat = roundHalfUp(v * 0.1); vatSum += vat;
    L.push({ acct: "선급부가세", memo: `${ym} 파렛트 임차료(${k})`, partner: AJ_PARTNER, supply: v, debit: vat, credit: 0 });
  }
  L.push({ acct: "외상매입금", memo: `${ym} 파렛트 임차료`, partner: AJ_PARTNER, debit: 0, credit: total + vatSum });
  return { lines: L, pool, brand, total, vat: vatSum };
}
