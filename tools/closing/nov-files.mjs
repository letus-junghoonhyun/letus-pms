import fs from "fs"; import * as XLSX from "xlsx"; import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readWorkbook, readAjPdf } from "../../src/closingFiles.js";
const D = "C:/Users/FURSYS/Desktop/운송/파렛트마감/레터스 11월/";
const out = {};
for (const f of fs.readdirSync(D)) {
  const p = D + f;
  try {
    let r;
    if (f.endsWith(".pdf")) { const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(p)), cMapUrl: "./node_modules/pdfjs-dist/cmaps/", cMapPacked: true, standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/" }).promise; const tc = await (await doc.getPage(1)).getTextContent(); r = readAjPdf(tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ")); if (r) r.kind = "ajPdf"; }
    else r = readWorkbook(XLSX.read(fs.readFileSync(p)), f);
    console.log(r && r.kind, "|", f, "|", r && r.note, r && r.from ? "| from " + r.from : "", r && r.account ? "| " + r.account + " " + r.supply + " " + JSON.stringify(r.gunae) : "");
    out[f] = r;
  } catch (e) { console.log("ERR", f, e.message); }
}
fs.writeFileSync(new URL("./nov-parsed.json", import.meta.url), JSON.stringify(out));
