// 월마감 자료 파일 읽기: 파일을 여러 개 한꺼번에 올리면 내용을 보고 종류를 알아낸다
//  · AJ 작업장별 거래명세서(엑셀, 시트마다 [합계]) → 작업장별 구내용·공급가액
//  · AJ 통합 거래명세서(PDF) → 계정별 공급가액(세금계산서 금액)·제품별 구내용
//  · ERP 제품구분별 수주/판매실적(엑셀) → 회사별 Total 내수(경인)·내수(지방)·수출 금액
//  · ERP 일/월기준 재고현황(엑셀) → Total 재고금액
//  · 11A 사용·출고내역(엑셀, 요약 시트) → 일룸·시디즈 출고수량
import * as XLSX from "xlsx";

const num = (v) => Number(String(v ?? "").replace(/[,\s원₩\\]/g, "")) || 0;
const clean = (n) => String(n || "").replace(/^\((폐쇄|차단_폐쇄)\)|^\[차단_폐쇄\]/, "").trim();

async function pdfText(file) {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  // AJ PDF는 한글 글꼴(CMap)을 써서 cMap 없이 읽으면 글자가 비어 나온다
  const base = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/";
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" }).promise;
  const page = await doc.getPage(1); // 첫 장(청구 요약)만 보면 된다
  const tc = await page.getTextContent();
  return tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ");
}

export function readAjPdf(t) {
  const who = (t.match(/(\S+?)\s*귀중/) || [])[1] || "";
  const sup = num((t.match(/공급가액\s*([\d,]+)/) || [])[1]);
  if (!sup) return null;
  let account = null;
  if (/맵핑금지/.test(t) && /14C,18F/.test(t)) account = "18F,14C";
  else if (/풀필먼트센터/.test(t)) account = "풀필먼트23E";
  else if (/23E전용/.test(t)) account = "23E";
  else if (/15A\s*전용/.test(t)) account = "15A";
  else if (/일반유형/.test(t)) account = "11A";
  if (!account) return { kind: "unknown", note: "AJ 거래명세서지만 어느 계정인지 모르겠어요: " + who };
  // 제품별 구내용: "11A ... 구 내 용 14,642 24 ..." 형태
  const gunae = {};
  const re = /(11A|15A|23E|14C,18F)\s*운송실비[^구]*구\s*내\s*용\s*([\d,]+)/g; let m;
  while ((m = re.exec(t))) gunae[m[1]] = num(m[2]);
  if (!Object.keys(gunae).length) { const g = t.match(/구\s*내\s*용\s*([\d,]+)/); if (g) gunae[account] = num(g[1]); }
  const period = (t.match(/사용기간\s*:?\s*(\d{4})년\s*(\d{2})월\s*(\d{2})일/) || []).slice(1).join("-");
  return { kind: "ajPdf", account, supply: sup, gunae, from: period, note: `AJ 통합 거래명세서 ${account} 공급가액 ${sup.toLocaleString()}` };
}

export function readWorkbook(wb, fileName) {
  // 시트 범위가 B열부터 시작해도 열 번호가 A열 기준이 되게 A1부터 읽는다
  const fromA1 = (ws) => { const ref = ws["!ref"]; if (!ref) return []; const e = XLSX.utils.decode_range(ref).e; return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", range: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e }) }); };
  const sheets = wb.SheetNames.map((n) => ({ name: n, rows: fromA1(wb.Sheets[n]) }));
  // AJ 작업장별 거래명세서: 시트 여러 개에 [합계]
  const withTot = sheets.filter((s) => s.rows.some((r) => String(r[1]).includes("[합계]")));
  if (withTot.length >= 3) {
    const gunae = {}, supply = {};
    withTot.forEach((s) => {
      const name = clean(String((s.rows[2] || [])[1] || s.name).trim());
      const tot = s.rows.find((r) => String(r[1]).includes("[합계]"));
      gunae[name] = num(tot[8]);
      const sp = s.rows.find((r) => String(r[1]).trim() === "공급가액");
      if (sp) supply[name] = num(sp[2]);
    });
    const p = sheets[0].rows.map((r) => r.join(" ")).join(" ").match(/(\d{4})년\s*(\d{2})월\s*(\d{2})일\s*~/);
    return { kind: "ajSheets", gunae, supply, from: p ? `${p[1]}-${p[2]}-${p[3]}` : "", note: `AJ 작업장별 거래명세서 ${withTot.length}곳` };
  }
  for (const s of sheets) {
    const hi = s.rows.findIndex((r) => r.some((c) => String(c).includes("내수금액(경인)")));
    if (hi >= 0) { // ERP 제품구분별 수주/판매실적
      const h = s.rows[hi].map(String);
      const col = (k) => h.findIndex((c) => c.includes(k));
      const tot = s.rows.slice(hi + 1).find((r) => String(r[0]).trim() === "Total" || String(r[1]).trim() === "Total");
      const company = ["퍼시스", "일룸", "시디즈"].find((c) => fileName.includes(c)) || (s.rows.slice(0, hi).map((r) => r.join(" ")).join(" ").match(/회사\s*:\s*(퍼시스|일룸|시디즈)/) || [])[1];
      if (!tot) return { kind: "unknown", note: "ERP 수주/판매실적인데 Total 줄이 없어요" };
      if (!company) return { kind: "unknown", note: "ERP 수주/판매실적인데 회사를 모르겠어요 — 파일 이름에 퍼시스/일룸/시디즈를 넣어 주세요" };
      const v = { 경인: num(tot[col("내수금액(경인)")]), 지방: num(tot[col("내수금액(지방)")]), 수출: num(tot[col("수출금액")]), 합계: num(tot[col("합계금액")]) };
      return { kind: "erp", company, value: v, note: `ERP 수주/판매실적 ${company} (경인 ${v.경인.toLocaleString()} / 지방 ${v.지방.toLocaleString()} / 수출 ${v.수출.toLocaleString()})` };
    }
    const si = s.rows.findIndex((r) => r.some((c) => String(c).trim() === "재고금액"));
    if (si >= 0) { // ERP 일/월기준 재고현황
      const c = s.rows[si].findIndex((x) => String(x).trim() === "재고금액");
      const tot = s.rows.slice(si + 1).reverse().find((r) => String(r[0]).trim() === "Total");
      if (tot) return { kind: "stock", amount: num(tot[c]), note: `ERP 재고현황 Total 재고금액 ${num(tot[c]).toLocaleString()}` };
    }
  }
  const sum = sheets.find((s) => s.name.includes("요약"));
  if (sum) { // 11A 사용·출고내역 요약
    const row = (k) => sum.rows.find((r) => String(r[1]).trim() === k);
    const il = row("일룸"), si = row("시디즈");
    if (il || si) return { kind: "out11A", value: { 일룸: num(il && il[3]), 시디즈: num(si && si[3]) }, note: `11A 출고수량 일룸 ${num(il && il[3])} / 시디즈 ${num(si && si[3])}` };
  }
  return { kind: "unknown", note: "어떤 자료인지 모르겠어요" };
}

export async function readClosingFile(file) {
  try {
    if (/\.pdf$/i.test(file.name)) { const r = readAjPdf(await pdfText(file)); return r || { kind: "unknown", note: "PDF에서 공급가액을 못 찾았어요" }; }
    const wb = XLSX.read(await file.arrayBuffer());
    return readWorkbook(wb, file.name);
  } catch (e) { return { kind: "unknown", note: "읽기 실패: " + (e.message || e) }; }
}
