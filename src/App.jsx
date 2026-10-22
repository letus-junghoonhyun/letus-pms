import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { supabase } from "./supabase.js";

const C = {
  dark: "#1d2235", dark2: "#2f3650", side: "#b9c0d4",
  teal: "#1D9E75", tealBg: "#E1F5EE", tealDk: "#0F6E56",
  page: "#f4f5f7", card: "#ffffff", border: "#e4e5e9",
  text: "#1f2430", sub: "#6b7280", hint: "#9ca3af",
  blue: "#185FA5", blueBg: "#E6F1FB",
  amber: "#854F0B", amberBg: "#FAEEDA",
  red: "#A32D2D", redBg: "#FCEBEB",
  green: "#3B6D11", greenBg: "#EAF3DE",
};

const DELIVERED = ["입고확인", "회수요청", "회수완료"];
const daysSince = (d) => Math.max(0, Math.round((Date.now() - new Date(d)) / 86400000));
const isReturn = (s) => s.direction === "반납";
// 미회수: 우리가 거래처로 보낸(정방향) 것 중 아직 안 돌아온 것만. 반납은 제외.
const isUnrecovered = (s) => !isReturn(s) && s.direction !== "이동" && (s.status === "출고완료" || s.status === "입고확인") && daysSince(s.depart_at) >= 7;
const DirBadge = ({ s }) => s.direction === "업체간"
  ? <span style={{ fontSize: 10, color: "#185FA5", background: "#E6F1FB", padding: "1px 6px", borderRadius: 10 }}>작업장 간</span>
  : isMove(s)
  ? <span style={{ fontSize: 10, color: "#5b3aa6", background: "#efe8ff", padding: "1px 6px", borderRadius: 10 }}>센터이동</span>
  : isReturn(s)
    ? <span style={{ fontSize: 10, color: "#854F0B", background: "#FAEEDA", padding: "1px 6px", borderRadius: 10 }}>반납</span>
    : <span style={{ fontSize: 10, color: "#185FA5", background: "#E6F1FB", padding: "1px 6px", borderRadius: 10 }}>출고</span>;
const won = (n) => "₩" + (n || 0).toLocaleString();
// 연락처 자동 하이픈 (숫자만 입력하면 010-1234-5678 형태로)
const formatPhone = (v) => {
  const d = (v || "").replace(/\D/g, "").slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 7) return d.slice(0, 3) + "-" + d.slice(3);
  if (d.length <= 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
  return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7);
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + Math.random());

const ST = {
  출고완료: { bg: C.blueBg, fg: C.blue }, 입고확인: { bg: C.greenBg, fg: C.green },
  회수요청: { bg: C.amberBg, fg: C.amber }, 회수완료: { bg: "#eef0f3", fg: C.sub }, 미회수: { bg: C.redBg, fg: C.red },
};
const Pill = ({ status }) => {
  const s = ST[status] ?? { bg: C.page, fg: C.sub };
  return <span style={{ fontSize: 12.5, padding: "3px 10px", borderRadius: 20, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>{status}</span>;
};
const Metric = ({ label, value, unit, tone }) => {
  const m = { danger: { bg: C.redBg, fg: C.red }, warn: { bg: C.amberBg, fg: C.amber }, info: { bg: C.blueBg, fg: C.blue }, success: { bg: C.greenBg, fg: C.green }, plain: { bg: "#eef0f3", fg: C.text } }[tone] ?? {};
  return (
    <div style={{ background: m.bg, borderRadius: 10, padding: "13px 16px", flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.5, color: tone === "plain" ? C.sub : m.fg }}>{label}</div>
      <div style={{ fontSize: 25, fontWeight: 600, marginTop: 3, color: m.fg }}>{value}{unit && <span style={{ fontSize: 13, color: tone === "plain" ? C.hint : m.fg }}> {unit}</span>}</div>
    </div>
  );
};
const Head = ({ title, sub, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
    <div><h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{title}</h2><p style={{ margin: "3px 0 0", fontSize: 13, color: C.hint }}>{sub}</p></div>
    {action}
  </div>
);
const Note = ({ children }) => <p style={{ fontSize: 12.5, color: C.hint, marginTop: 14, lineHeight: 1.6 }}>{children}</p>;
const tbl = { width: "100%", borderCollapse: "collapse" };
const btnTeal = { fontSize: 13.5, padding: "9px 15px", borderRadius: 8, border: "none", background: C.teal, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 };
const btnTealSm = { fontSize: 12.5, padding: "6px 12px", borderRadius: 7, border: "none", background: C.teal, color: "#fff", cursor: "pointer" };
const btnGhost = { fontSize: 12.5, padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", color: C.text };
const btnGreen = { fontSize: 13.5, padding: "9px 15px", borderRadius: 8, border: "none", background: C.green, color: "#fff", cursor: "pointer" };
const Td = ({ children, r, b, c }) => <td style={{ padding: "12px 7px", fontSize: 13.5, textAlign: r ? "right" : "left", fontWeight: b ? 600 : 400, color: c ?? C.text }}>{children}</td>;
const Th = ({ children, r }) => <th style={{ fontSize: 12.5, color: C.hint, fontWeight: 400, textAlign: r ? "right" : "left", padding: "10px 7px" }}>{children}</th>;
const TYPE_BADGE = { 시공팀: { bg: C.blueBg, fg: C.blue }, 센터: { bg: C.amberBg, fg: C.amber }, 업체: { bg: "#eef0f3", fg: C.sub } };
const TypeBadge = ({ t }) => { const b = TYPE_BADGE[t] || TYPE_BADGE.업체; return <span style={{ fontSize: 11, color: b.fg, background: b.bg, padding: "2px 8px", borderRadius: 20 }}>{t}</span>; };

// 메인 센터 (우리 보유 거점) — 추후 마스터 데이터로 보완 예정
const CENTERS = ["양지물류센터", "안성센터", "평택센터"];
const OPENING_CENTER = "양지물류센터";   // 가설정 오프닝 재고를 두는 센터
const OPENING_QTY = 5000;                // 파렛트 종류별 오프닝 수량

const sum = (arr) => arr.reduce((a, s) => a + (s.qty || 0), 0);

// 거래처(업체/시공팀)가 현재 보유한 수량
//  = 입고확인된 정방향 − 센터로 반납(신청/확인) − AJ로 회수 완료
const heldQty = (ships, ajReqs, partnerCode, palletCode) => {
  const out = sum(ships.filter((s) => !isReturn(s) && s.to_partner === partnerCode && s.pallet_code === palletCode && !s.canceled && s.status === "입고확인"));
  const ret = sum(ships.filter((s) => isReturn(s) && s.to_partner === partnerCode && s.pallet_code === palletCode && ["출고완료", "입고확인"].includes(s.status)));
  const ajr = sum(ajReqs.filter((r) => r.type === "회수" && r.partner_code === partnerCode && r.pallet_code === palletCode && r.status === "완료"));
  return Math.max(0, out - ret - ajr);
};
// 보유분 중 아직 회수요청 안 한 잔여(추가 회수/반납 가능 수량)
const availableToRecover = (ships, ajReqs, partnerCode, palletCode) => {
  const pending = sum(ajReqs.filter((r) => r.type === "회수" && r.partner_code === partnerCode && r.pallet_code === palletCode && r.status === "요청"));
  return Math.max(0, heldQty(ships, ajReqs, partnerCode, palletCode) - pending);
};
// 센터 보유 재고(장부) = 오프닝 − 이 센터에서 정방향 출고(나감) + 이 센터로 반납 입고확인 + AJ공급 완료 − 센터→AJ 회수 완료
const centerStock = (ships, ajReqs, center, palletCode) => {
  let q = center === OPENING_CENTER ? OPENING_QTY : 0;
  q -= sum(ships.filter((s) => !isReturn(s) && !isMove(s) && s.center === center && s.pallet_code === palletCode && !s.canceled && ["출고완료", "입고확인"].includes(s.status)));
  q += sum(ships.filter((s) => isReturn(s) && s.center === center && s.pallet_code === palletCode && s.status === "입고확인"));
  // 센터 이동: 출발센터는 출고완료 시점에 −, 도착센터는 입고확인 시점에 +
  q -= sum(ships.filter((s) => isMove(s) && s.center === center && s.pallet_code === palletCode && !s.canceled && ["출고완료", "입고확인"].includes(s.status)));
  q += sum(ships.filter((s) => isMove(s) && s.to_center === center && s.pallet_code === palletCode && s.status === "입고확인"));
  q += sum(ajReqs.filter((r) => r.type === "공급" && r.center === center && r.pallet_code === palletCode && r.status === "완료"));
  q -= sum(ajReqs.filter((r) => r.type === "회수" && r.center === center && !r.partner_code && r.pallet_code === palletCode && r.status === "완료"));
  return q;
};
// 날짜·시간 포맷
const fmtDT = (iso) => { if (!iso) return "—"; const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const isMove = (s) => s.direction === "이동";
// 출고처 → 입고처 (방향 기준). 정방향: 센터→거래처 / 반납: 거래처→센터 / 이동: 센터→센터
const fromOf = (s) => isMove(s) ? (s.center || "—") : isReturn(s) ? s.to_partner_name : (s.center || "렌탈사");
const toOf = (s) => isMove(s) ? (s.to_center || "—") : isReturn(s) ? (s.center || "렌탈사") : s.to_partner_name;

// ─── 역할 & 권한 ─────────────────────────────────────────────
const ROLES = ["관리자", "운송팀", "정산담당", "협력업체", "AJ"];
const NAV_BY_ROLE = {
  관리자: ["현황", "출고", "확인", "회수", "재고", "AJ", "EDI", "마스터", "단가", "사용자", "설정"],
  운송팀: ["현황", "출고", "확인", "회수", "재고", "AJ", "EDI", "마스터", "설정"],
  정산담당: ["현황", "재고", "EDI", "마스터", "설정"],
  협력업체: ["현황", "반납", "확인", "설정"],
  AJ: ["AJ", "설정"],   // AJ네트웍스 직원: 요청 처리 + 내 설정
};
// 역할별 능력치 (화면 가리기 + 버튼 잠금에 사용 / DB는 RLS가 별도로 막음)
const capsOf = (role) => ({
  outbound: ["관리자", "운송팀"].includes(role),   // 출고 등록(방향 선택 가능)
  operate: ["관리자", "운송팀"].includes(role),     // 회수·반납 등 내부 조치
  confirmOwn: role === "협력업체",                   // 본인 건 입고확인만
  returnReg: role === "협력업체",                    // 반납 출고 등록(거래처→우리)
  master: ["관리자", "운송팀"].includes(role),       // 거래처 등록·엑셀
  priceEdit: ["관리자", "정산담당"].includes(role),  // 단가 편집
  billing: ["관리자", "정산담당"].includes(role),    // 정산 확정
  aj: ["관리자", "운송팀"].includes(role),           // AJ 요청 생성·관리(우리쪽)
  ajWorker: role === "AJ",                            // AJ네트웍스 직원: 요청 완료 처리
  inventory: ["관리자", "운송팀", "정산담당"].includes(role), // 재고 현황 조회
  users: role === "관리자",                          // 사용자 관리
});

// ─── 인증 화면 ───────────────────────────────────────────────
function Auth() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [company, setCompany] = useState("");
  const [pname, setPname] = useState(""); const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setMsg("");
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        setMsg(error ? error.message : "재설정 메일을 보냈어요. 메일의 링크를 누르면 새 비밀번호를 정할 수 있어요. (실제 이메일 계정만 수신됩니다)");
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) setMsg(error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: pw });
        if (error) { setMsg(error.message); }
        else {
          const u = data.user;
          if (u) {
            await supabase.from("profiles").upsert({ id: u.id, name: pname || company || email.split("@")[0], email, company: company || null, phone: phone || null });
            await supabase.from("user_roles").upsert({ user_id: u.id, role: "협력업체" }, { onConflict: "user_id" });
          }
          if (!data.session) setMsg("가입 완료! 로그인하세요. (로그인이 안 되면 Supabase에서 이메일 인증을 꺼주세요)");
          else setMsg("");
        }
      }
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.page, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ background: C.dark, borderRadius: 14, padding: "22px 20px", textAlign: "center", marginBottom: 14 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: C.teal, color: "#04342C", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 17 }}>L</div>
            <span style={{ color: "#fff", fontWeight: 600, fontSize: 19 }}>LETUS PMS</span>
          </div>
          <div style={{ color: "#8b93ab", fontSize: 12, marginTop: 6 }}>파렛트 렌탈 수불관리 시스템</div>
        </div>
        <div style={{ background: C.card, borderRadius: 14, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 16, background: "#eef0f3", borderRadius: 10, padding: 4 }}>
            {["login", "signup"].map((m) => (
              <button key={m} onClick={() => { setMode(m); setMsg(""); }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, background: mode === m ? C.teal : "transparent", color: mode === m ? "#fff" : C.sub }}>
                {m === "login" ? "로그인" : "신규 가입"}
              </button>
            ))}
          </div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
          {mode === "signup" && <input value={pname} onChange={(e) => setPname(e.target.value)} placeholder="담당자 이름" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />}
          {mode === "signup" && <input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} inputMode="numeric" placeholder="연락처(휴대폰)" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />}
          {mode === "signup" && <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="회사명(거래처명)" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />}
          {mode !== "forgot" && <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="비밀번호" onKeyDown={(e) => e.key === "Enter" && submit()} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }} />}
          {mode === "signup" && <div style={{ fontSize: 11, color: C.hint, marginBottom: 12, lineHeight: 1.5 }}>가입 후 관리자가 소속 거래처를 연결하면 본인 거래처 건이 보여요.</div>}
          {mode === "forgot" && <div style={{ fontSize: 11, color: C.hint, marginBottom: 12, lineHeight: 1.5 }}>가입한 이메일을 넣으면 비밀번호 재설정 링크를 보내드려요.</div>}
          {msg && <div style={{ fontSize: 12, color: msg.startsWith("재설정") ? C.green : C.red, background: msg.startsWith("재설정") ? C.greenBg : C.redBg, padding: "8px 10px", borderRadius: 8, marginBottom: 12 }}>{msg}</div>}
          <button disabled={busy || !email || (mode !== "forgot" && !pw)} onClick={submit} style={{ width: "100%", background: busy ? "#c7cad1" : C.teal, color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 15, cursor: "pointer" }}>
            {busy ? "처리 중…" : mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : "재설정 메일 보내기"}
          </button>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            {mode === "forgot"
              ? <button onClick={() => { setMode("login"); setMsg(""); }} style={{ background: "none", border: "none", color: C.sub, fontSize: 12, cursor: "pointer" }}>← 로그인으로</button>
              : <button onClick={() => { setMode("forgot"); setMsg(""); }} style={{ background: "none", border: "none", color: C.sub, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>비밀번호를 잊으셨나요?</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 메인 앱 ─────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true); // 재설정 메일 링크로 들어옴
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!authReady) return <Splash text="불러오는 중…" />;
  if (recovering) return <ResetPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Auth />;
  const confirmParam = new URLSearchParams(window.location.search).get("confirm");
  return <Shell session={session} initialConfirm={confirmParam} />;
}

// 비밀번호 재설정(메일 링크로 진입했을 때) 새 비밀번호 입력 화면
function ResetPassword({ onDone }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => {
    if (pw.length < 6) { setMsg("비밀번호는 6자 이상이어야 해요."); return; }
    if (pw !== pw2) { setMsg("두 비밀번호가 달라요."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setMsg(error.message);
    else { alert("비밀번호가 변경됐어요. 다시 로그인해주세요."); await supabase.auth.signOut(); onDone(); }
  };
  return (
    <div style={{ minHeight: "100vh", background: C.page, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 360, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 17 }}>새 비밀번호 설정</h2>
        <p style={{ fontSize: 12, color: C.sub, margin: "0 0 16px" }}>사용할 새 비밀번호를 입력하세요.</p>
        <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="새 비밀번호(6자 이상)" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
        <input value={pw2} onChange={(e) => setPw2(e.target.value)} type="password" placeholder="새 비밀번호 확인" onKeyDown={(e) => e.key === "Enter" && save()} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }} />
        {msg && <div style={{ fontSize: 12, color: C.red, background: C.redBg, padding: "8px 10px", borderRadius: 8, marginBottom: 12 }}>{msg}</div>}
        <button disabled={busy} onClick={save} style={{ width: "100%", background: busy ? "#c7cad1" : C.teal, color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 15, cursor: "pointer" }}>{busy ? "변경 중…" : "비밀번호 변경"}</button>
      </div>
    </div>
  );
}

const Splash = ({ text }) => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: C.sub, fontFamily: "system-ui, sans-serif", fontSize: 14 }}>{text}</div>
);

function Shell({ session, initialConfirm }) {
  const [nav, setNav] = useState("현황");
  const [focusBatch, setFocusBatch] = useState(initialConfirm || null);
  const [scanOpen, setScanOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 뒤로가기 처리용 최신 상태 ref (핸들러는 1번만 등록)
  const backRef = useRef({});
  backRef.current = { scanOpen, drawerOpen, focusBatch, nav, setScanOpen, setDrawerOpen, setFocusBatch, setNav };
  useEffect(() => {
    window.history.pushState({ app: true }, "");
    const repush = () => window.history.pushState({ app: true }, "");
    const onPop = () => {
      const st = backRef.current;
      if (st.scanOpen) { st.setScanOpen(false); repush(); return; }
      if (st.drawerOpen) { st.setDrawerOpen(false); repush(); return; }
      if (st.focusBatch) { st.setFocusBatch(null); repush(); return; }
      if (st.nav !== "현황") { st.setNav("현황"); repush(); return; }
      // 홈: 종료 확인 (예=나가기 / 아니오=머무르기)
      if (window.confirm("앱을 종료할까요?")) { window.removeEventListener("popstate", onPop); window.history.back(); }
      else { repush(); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [palletTypes, setPalletTypes] = useState([]);
  const [prices, setPrices] = useState({});
  const [partners, setPartners] = useState([]);
  const [contracted, setContracted] = useState({});
  const [ships, setShips] = useState([]);
  const [role, setRole] = useState("");
  const [flash, setFlash] = useState(null);
  const [users, setUsers] = useState([]);
  const [blocked, setBlocked] = useState(false);
  const [ajReqs, setAjReqs] = useState([]);
  const [centers, setCenters] = useState([]);        // 활성 센터 이름 목록
  const [myCenterCodes, setMyCenterCodes] = useState(null); // 내 담당 센터(없으면 전체)
  const [me, setMe] = useState({});                  // 내 프로필(이름/연락처)

  const loadAll = useCallback(async () => {
    setErr("");
    try {
      const [pt, up, pa, pp, sh, ur, me, aj, ct] = await Promise.all([
        supabase.from("pallet_type").select("*").order("code"),
        supabase.from("unit_price").select("*"),
        supabase.from("partner").select("*").eq("active", true).order("name"),
        supabase.from("partner_pallet").select("*"),
        supabase.from("shipment").select("*").order("depart_at", { ascending: false }),
        supabase.from("user_roles").select("role").eq("user_id", session.user.id).maybeSingle(),
        supabase.from("profiles").select("active, center_codes, name, phone").eq("id", session.user.id).maybeSingle(),
        supabase.from("aj_request").select("*").order("requested_at", { ascending: false }),
        supabase.from("app_center").select("name, active").eq("active", true).order("name"),
      ]);
      // 비활성 계정이면 차단 (active 컬럼 없으면 undefined → 통과)
      if (me?.data && me.data.active === false) { setBlocked(true); setLoading(false); return; }
      setCenters((ct.data || []).map((c) => c.name));
      setMyCenterCodes(me?.data?.center_codes || null);
      setMe(me?.data || {});
      // 단가·AJ는 협력업체에게 RLS로 막혀 빈 값이 올 수 있어요 — 에러 아니므로 제외하고 검사
      const firstErr = [pt, pa, pp, sh].find((r) => r.error);
      if (firstErr) throw firstErr.error;
      setPalletTypes(pt.data || []);
      const pm = {}; (up.data || []).forEach((r) => { pm[r.pallet_code] = r.price; });
      setPrices(pm);
      setPartners(pa.data || []);
      const cm = {}; (pp.data || []).forEach((r) => { (cm[r.partner_code] = cm[r.partner_code] || []).push(r.pallet_code); });
      setContracted(cm);
      setShips((sh.data || []).filter((s) => !s.canceled)); // 취소건 제외 (canceled 컬럼 없으면 전부 통과)
      setAjReqs(aj.data || []);
      setRole(ur?.data?.role || "협력업체");
    } catch (e) {
      setErr("데이터를 불러오지 못했어요: " + (e.message || e));
    }
    setLoading(false);
  }, [session.user.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 사용자 관리(관리자 전용): 가입자 목록 + 역할/소속거래처/계정상태
  const loadUsers = useCallback(async () => {
    const [pf, ur] = await Promise.all([
      supabase.from("profiles").select("id, name, email, company, partner_code, active, center_codes"),
      supabase.from("user_roles").select("user_id, role"),
    ]);
    const rm = {}; (ur.data || []).forEach((r) => { rm[r.user_id] = r.role; });
    setUsers((pf.data || []).map((p) => ({ ...p, active: p.active !== false, role: rm[p.id] || "협력업체" })));
  }, []);

  const setUserRole = async (userId, newRole) => {
    try {
      const { error } = await supabase.from("user_roles").upsert({ user_id: userId, role: newRole }, { onConflict: "user_id" });
      if (error) throw error;
      if (newRole !== "협력업체") await supabase.from("profiles").update({ partner_code: null }).eq("id", userId);
      await loadUsers();
    } catch (e) { alert("역할 변경 실패: " + (e.message || e)); }
  };
  const setUserPartner = async (userId, partnerCode) => {
    try {
      const { error } = await supabase.from("profiles").update({ partner_code: partnerCode }).eq("id", userId);
      if (error) throw error;
      await loadUsers();
    } catch (e) { alert("소속 거래처 변경 실패: " + (e.message || e)); }
  };
  const setUserActive = async (userId, active) => {
    try {
      const { error } = await supabase.from("profiles").update({ active }).eq("id", userId);
      if (error) throw error;
      await loadUsers();
    } catch (e) { alert("계정 상태 변경 실패: " + (e.message || e)); }
  };
  // 관리자 비밀번호 초기화 (Edge Function 'admin-reset-password' 호출)
  const adminResetPassword = async (u) => {
    const temp = "letus" + Math.floor(1000 + Math.random() * 9000);
    if (!window.confirm(`'${u.company || u.email || u.name}' 계정의 비밀번호를 임시 비밀번호로 초기화할까요?`)) return;
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-password", { body: { userId: u.id, newPassword: temp } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      window.prompt("임시 비밀번호가 설정됐어요. 사용자에게 전달하세요(복사 후 닫기):", temp);
    } catch (e) {
      alert("비밀번호 초기화 실패: " + (e.message || e) + "\n\n(Edge Function 'admin-reset-password'가 배포됐는지 확인하세요)");
    }
  };

  // lines: [{ pallet, qty }] — 여러 파렛트 종류를 한 번에 등록(혼합). 전표번호는 유형마다 고유 발급.
  const register = async (partner, lines, departDate, note, direction = "출고", center = null, photos = [], vehicleNo = null, outSign = null) => {
    const valid = (lines || []).filter((l) => l.pallet && l.qty > 0);
    if (!valid.length) { alert("수량을 1개 이상 입력하세요."); return; }
    // 정방향 출고는 센터 재고 한도 초과 불가
    try {
      const batchId = uid();
      // 선택한 날짜 + 실제 처리 시각(시:분:초)을 반영
      const nowD = new Date();
      let depart_at = nowD.toISOString();
      if (departDate) { const [y, m, d] = departDate.split("-").map(Number); const dt = new Date(nowD); dt.setFullYear(y, m - 1, d); depart_at = dt.toISOString(); }
      const shipRows = [];
      for (const l of valid) {
        const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
        if (e1) throw e1;
        shipRows.push({
          id: uid(), slip_no: slip, to_partner: partner.code, to_partner_name: partner.name,
          pallet_code: l.pallet, qty: l.qty, status: "출고완료", direction, center,
          depart_at, note: note || null, vehicle_no: vehicleNo || null, batch_id: batchId, out_photos: photos.length ? photos : null,
          operator_name: me.name || (session.user.email || "").split("@")[0] || null, operator_phone: me.phone || null, out_sign_url: outSign || null, created_by: session.user.id,
        });
      }
      const { error: e2 } = await supabase.from("shipment").insert(shipRows);
      if (e2) throw e2;
      const mvRows = shipRows.map((s) => ({
        id: uid(), shipment_id: s.id, type: direction, direction, source: "앱", pallet_code: s.pallet_code, qty: s.qty,
        to_partner: partner.code, to_partner_name: partner.name, created_by: session.user.id,
      }));
      await supabase.from("movement").insert(mvRows);
      setFlash({ slip: shipRows[0].slip_no + (shipRows.length > 1 ? ` 외 ${shipRows.length - 1}건` : ""), batchId }); loadAll();
      return shipRows;
    } catch (e) { alert((direction === "반납" ? "반납" : "출고") + " 등록 실패: " + (e.message || e)); }
  };

  // ── AJ 연동: 공급/회수 요청 ──────────────────────────────
  const createAjRequest = async (req) => {
    // req: { type:'공급'|'회수', lines:[{pallet,qty}], center, partner, note }
    const valid = (req.lines || []).filter((l) => l.pallet && l.qty > 0);
    if (!valid.length) { alert("수량을 1개 이상 입력하세요."); return false; }
    try {
      const groups = {}; // 공급요청은 EDI 계정마다 한 건(묶음)으로 납품요청한다
      const rows = valid.map((l) => {
        const row = {
          id: uid(), type: req.type, pallet_code: l.pallet, qty: l.qty,
          center: req.center || null, partner_code: req.partner?.code || null, partner_name: req.partner?.name || null,
          status: "요청", note: req.note || null, created_by: session.user.id,
        };
        if (req.edi) {
          Object.assign(row, { wp_no: req.edi.wp_no, want_date: req.edi.want_date || null, want_time: req.edi.want_time || null, cars_oper: req.edi.cars_oper, cars_tons: req.edi.cars_tons || null, cars_type: req.edi.cars_type, phone: req.edi.phone || null });
          if (l.edi_account && l.edi_local) { groups[l.edi_account] = groups[l.edi_account] || uid().replace(/-/g, ""); Object.assign(row, { edi_account: l.edi_account, edi_local: l.edi_local, edi_group: groups[l.edi_account], edi_status: "대기" }); }
        }
        return row;
      });
      const { error } = await supabase.from("aj_request").insert(rows);
      if (error) throw new Error(error.message + (/want_date|edi_/.test(error.message) ? " (letus_edi11.sql 실행 필요)" : ""));
      await loadAll(); return true;
    } catch (e) { alert("AJ 요청 실패: " + (e.message || e)); return false; }
  };
  // AJ 직원 처리: 공급은 '발송'(우리 입고확인 대기), 회수는 '완료'(AJ가 가져감)
  const completeAjRequest = async (r) => {
    try {
      const patch = r.type === "공급"
        ? { status: "발송", sent_at: new Date().toISOString() }
        : { status: "완료", completed_at: new Date().toISOString() };
      const { error } = await supabase.from("aj_request").update(patch).eq("id", r.id);
      if (error) throw error;
      await loadAll();
    } catch (e) { alert("처리 실패: " + (e.message || e)); }
  };
  // 우리 센터 입고확인: 공급 '발송' → '완료' (이때 센터 재고 +)
  const confirmAjSupply = async (r) => {
    try {
      const { error } = await supabase.from("aj_request").update({ status: "완료", completed_at: new Date().toISOString() }).eq("id", r.id);
      if (error) throw error;
      await loadAll();
    } catch (e) { alert("입고확인 실패: " + (e.message || e)); }
  };
  const cancelAjRequest = async (r) => {
    if (!window.confirm("이 요청을 삭제할까요?")) return;
    try { await supabase.from("aj_request").delete().eq("id", r.id); await loadAll(); }
    catch (e) { alert("삭제 실패: " + (e.message || e)); }
  };

  // ── 회수 관리: 거래처 보유분을 센터로 반납 또는 AJ로 회수 ──
  const recoverToCenter = async (partner, pallet, qty, center) => {
    try {
      const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
      if (e1) throw e1;
      const id = uid(); const nowISO = new Date().toISOString();
      // 거래처→센터 반납을 즉시 입고확인 상태로 기록(내부가 회수 처리)
      const { error: e2 } = await supabase.from("shipment").insert({
        id, slip_no: slip, to_partner: partner.code, to_partner_name: partner.name,
        pallet_code: pallet, qty, status: "입고확인", direction: "반납", center,
        depart_at: nowISO, confirmed_at: nowISO, note: "회수관리:센터반납", batch_id: id, created_by: session.user.id,
      });
      if (e2) throw e2;
      await supabase.from("movement").insert({ id: uid(), shipment_id: id, type: "반납", direction: "반납", source: "앱", pallet_code: pallet, qty, to_partner: partner.code, to_partner_name: partner.name, created_by: session.user.id });
      await loadAll();
    } catch (e) { alert("센터 반납 실패: " + (e.message || e)); }
  };
  const recoverToAj = (partner, pallet, qty) =>
    createAjRequest({ type: "회수", lines: [{ pallet, qty }], partner, note: "회수관리:AJ회수" });

  // 작업장 간 자유 이동: EDI 작업장 아무 곳 → 아무 곳. 센터·거래처로 연결된 곳이면 기존 방향(출고/반납/이동)으로 저장해 기존 화면과 맞춘다
  const registerFree = async (fromWp, toWp, lines, departDate, note, photos = [], vehicleNo = null, outSign = null) => {
    const valid = (lines || []).filter((l) => l.pallet && l.qty > 0);
    if (!valid.length) { alert("수량을 1개 이상 입력하세요."); return; }
    if (!fromWp || !toWp) { alert("출발지와 도착지를 고르세요."); return; }
    if (fromWp.no === toWp.no) { alert("출발지와 도착지가 같아요."); return; }
    const centerOf = (w) => w.pms_center || (centerList.includes(ediClean(w.name)) ? ediClean(w.name) : null);
    const partnerOf = (w) => (w.partner_code ? partnersFull.find((p) => p.code === w.partner_code) : null);
    const fc = centerOf(fromWp), tc = centerOf(toWp), fp = partnerOf(fromWp), tp = partnerOf(toWp);
    let base;
    if (fc && tc) base = { direction: "이동", center: fc, to_center: tc, to_partner: null, to_partner_name: tc };
    else if (fc && tp) base = { direction: "출고", center: fc, to_partner: tp.code, to_partner_name: tp.name };
    else if (fp && tc) base = { direction: "반납", center: tc, to_partner: fp.code, to_partner_name: fp.name };
    else base = { direction: "업체간", center: fc || null, to_partner: tp ? tp.code : null, to_partner_name: ediClean(toWp.name) };
    try {
      const batchId = uid();
      const nowD = new Date();
      let depart_at = nowD.toISOString();
      if (departDate) { const [y, m, d] = departDate.split("-").map(Number); const dt = new Date(nowD); dt.setFullYear(y, m - 1, d); depart_at = dt.toISOString(); }
      const rows = [];
      for (const l of valid) {
        const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
        if (e1) throw e1;
        rows.push({ id: uid(), slip_no: slip, ...base, from_wp: fromWp.no, to_wp: toWp.no, from_name: ediClean(fromWp.name), pallet_code: l.pallet, qty: l.qty, status: "출고완료", depart_at, batch_id: batchId, out_photos: photos.length ? photos : null, vehicle_no: vehicleNo || null, note: note || null, operator_name: me.name || (session.user.email || "").split("@")[0] || null, operator_phone: me.phone || null, out_sign_url: outSign || null, created_by: session.user.id });
      }
      const { error: e2 } = await supabase.from("shipment").insert(rows);
      if (e2) throw new Error(e2.message + (/from_wp|to_wp|from_name/.test(e2.message) ? " (letus_edi10.sql 실행 필요)" : ""));
      await supabase.from("movement").insert(rows.map((r) => ({ id: uid(), shipment_id: r.id, type: r.direction, direction: r.direction, source: "앱", pallet_code: r.pallet_code, qty: r.qty, to_partner: r.to_partner, to_partner_name: r.to_partner_name, created_by: session.user.id })));
      setFlash({ slip: rows[0].slip_no + (rows.length > 1 ? " 외 " + (rows.length - 1) + "건" : ""), batchId }); loadAll();
      return rows;
    } catch (e) { alert("등록 실패: " + (e.message || e)); }
  };

  // 센터 간 재고 이동 (출발센터 − / 도착센터 +)
  const transferCenters = async (fromC, toC, lines, photos = [], vehicleNo = null, note = null, outSign = null) => {
    const valid = (lines || []).filter((l) => l.pallet && l.qty > 0);
    if (!valid.length) { alert("수량을 1개 이상 입력하세요."); return; }
    if (fromC === toC) { alert("출발 센터와 도착 센터가 같아요."); return; }
    try {
      const batchId = uid();
      const nowISO = new Date().toISOString();
      const rows = [];
      for (const l of valid) {
        const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
        if (e1) throw e1;
        rows.push({ id: uid(), slip_no: slip, to_partner: null, to_partner_name: toC, pallet_code: l.pallet, qty: l.qty, status: "출고완료", direction: "이동", center: fromC, to_center: toC, depart_at: nowISO, batch_id: batchId, out_photos: photos.length ? photos : null, vehicle_no: vehicleNo || null, note: note || null, operator_name: me.name || (session.user.email || "").split("@")[0] || null, operator_phone: me.phone || null, out_sign_url: outSign || null, created_by: session.user.id });
      }
      const { error: e2 } = await supabase.from("shipment").insert(rows);
      if (e2) throw e2;
      await supabase.from("movement").insert(rows.map((s) => ({ id: uid(), shipment_id: s.id, type: "이동", direction: "이동", source: "앱", pallet_code: s.pallet_code, qty: s.qty, to_partner: null, to_partner_name: toC, created_by: session.user.id })));
      setFlash({ slip: rows[0].slip_no + (rows.length > 1 ? ` 외 ${rows.length - 1}건` : ""), batchId }); loadAll();
      return rows;
    } catch (e) { alert("센터 이동 실패: " + (e.message || e)); }
  };

  // 단가 편집 (관리자·정산담당)
  const setPrice = async (code, price) => {
    try {
      const { data: ex } = await supabase.from("unit_price").select("pallet_code").eq("pallet_code", code).limit(1);
      const op = ex && ex.length
        ? supabase.from("unit_price").update({ price }).eq("pallet_code", code)
        : supabase.from("unit_price").insert({ pallet_code: code, price });
      const { error } = await op;
      if (error) throw error;
      await loadAll();
    } catch (e) { alert("단가 저장 실패: " + (e.message || e)); }
  };

  // 출고 수정 (수량·유형·날짜·메모)
  const editShipment = async (s, patch) => {
    try {
      const { error } = await supabase.from("shipment").update(patch).eq("id", s.id);
      if (error) throw error;
      await supabase.from("movement").insert({
        id: uid(), shipment_id: s.id, type: "조정", source: "앱",
        pallet_code: patch.pallet_code ?? s.pallet_code, qty: patch.qty ?? s.qty,
        to_partner: s.to_partner, to_partner_name: s.to_partner_name, created_by: session.user.id,
      });
      await loadAll();
    } catch (e) { alert("출고 수정 실패: " + (e.message || e)); }
  };

  // 출고 취소 (소프트 삭제 — 이력 보존)
  const cancelShipment = async (s) => {
    try {
      const { error } = await supabase.from("shipment").update({ canceled: true, status: "취소" }).eq("id", s.id);
      if (error) throw error;
      await supabase.from("movement").insert({
        id: uid(), shipment_id: s.id, type: "취소", source: "앱", pallet_code: s.pallet_code, qty: s.qty,
        to_partner: s.to_partner, to_partner_name: s.to_partner_name, created_by: session.user.id,
      });
      await loadAll();
    } catch (e) { alert("출고 취소 실패: " + (e.message || e)); }
  };

  const setStatus = async (s, newStatus, mvType, inPhotos, inSign, receivedQty) => {
    try {
      const patch = { status: newStatus };
      if (newStatus === "입고확인") {
        if (!s.confirmed_at) patch.confirmed_at = new Date().toISOString();
        patch.receiver_name = me.name || (session.user.email || "").split("@")[0] || null; // 입고확인한 담당자 자동 기록
        patch.receiver_phone = me.phone || null;
        if (inSign) patch.in_sign_url = inSign;
        if (receivedQty != null) { patch.received_qty = receivedQty; patch.discrepancy = receivedQty !== s.qty; }
      }
      if (inPhotos && inPhotos.length) patch.in_photos = inPhotos;
      const { error } = await supabase.from("shipment").update(patch).eq("id", s.id);
      if (error) throw error;
      if (mvType) await supabase.from("movement").insert({
        id: uid(), shipment_id: s.id, type: mvType, source: "앱", pallet_code: s.pallet_code, qty: s.qty,
        to_partner: s.to_partner, to_partner_name: s.to_partner_name, created_by: session.user.id,
      });
      loadAll();
    } catch (e) { alert("상태 변경 실패: " + (e.message || e)); }
  };

  // ⚠️ 테스트용: 출고/반납/이동 데이터 전체 삭제 (거래처·단가·계정은 유지). 운영 전환 시 제거.
  const resetData = async () => {
    if (!window.confirm("[테스트 초기화]\n모든 출고·반납·이동 데이터를 삭제합니다.\n거래처·단가·계정은 유지됩니다.\n\n되돌릴 수 없어요. 진행할까요?")) return;
    if (!window.confirm("마지막 확인 — 정말 모두 삭제할까요?")) return;
    try {
      // 자식 테이블(shipment 참조)부터 삭제 후 shipment
      for (const t of ["return_request", "confirmation", "movement", "aj_request"]) {
        const r = await supabase.from(t).delete().not("id", "is", null);
        if (r.error && !/does not exist|relation/i.test(r.error.message || "")) throw r.error;
      }
      const b = await supabase.from("shipment").delete().not("id", "is", null);
      if (b.error) throw b.error;
      await loadAll();
      alert("초기화 완료 — 출고/반납 데이터가 모두 삭제됐어요.");
    } catch (e) { alert("초기화 실패: " + (e.message || e)); }
  };

  // 수량상이 해결 — 협의된 최종 수량으로 확정 + 플래그 해제
  const resolveDiscrepancy = async (s, finalQty) => {
    try {
      const { error } = await supabase.from("shipment").update({ qty: finalQty, received_qty: finalQty, discrepancy: false }).eq("id", s.id);
      if (error) throw error;
      await supabase.from("movement").insert({ id: uid(), shipment_id: s.id, type: "조정", source: "앱", pallet_code: s.pallet_code, qty: finalQty, to_partner: s.to_partner, to_partner_name: s.to_partner_name, created_by: session.user.id });
      await loadAll();
    } catch (e) { alert("처리 실패: " + (e.message || e)); }
  };

  const addPartner = async (name, type) => {
    try {
      const code = "P" + Date.now().toString().slice(-7);
      const { error } = await supabase.from("partner").insert({ code, name, type });
      if (error) throw error;
      loadAll();
    } catch (e) { alert("거래처 등록 실패: " + (e.message || e)); }
  };

  // 센터 마스터 관리
  const addCenter = async (name) => {
    try { const { error } = await supabase.from("app_center").insert({ name }); if (error) throw error; await loadAll(); }
    catch (e) { alert("센터 추가 실패: " + (e.message || e)); }
  };
  const toggleCenter = async (name, active) => {
    try { const { error } = await supabase.from("app_center").update({ active }).eq("name", name); if (error) throw error; await loadAll(); }
    catch (e) { alert("센터 상태 변경 실패: " + (e.message || e)); }
  };
  const setUserCenters = async (userId, names) => {
    try { const { error } = await supabase.from("profiles").update({ center_codes: names }).eq("id", userId); if (error) throw error; await loadUsers(); }
    catch (e) { alert("담당 센터 변경 실패: " + (e.message || e)); }
  };

  // 거래처 삭제(소프트) — 재고 보유/진행중이면 차단, 이력은 보존
  const deletePartner = async (p) => {
    if (!window.confirm(`'${p.name}' 거래처를 삭제할까요?\n(과거 출고 이력은 보존되고 목록에서만 사라져요)`)) return;
    try {
      const { error } = await supabase.from("partner").update({ active: false }).eq("code", p.code);
      if (error) throw error;
      await loadAll();
    } catch (e) { alert("거래처 삭제 실패: " + (e.message || e)); }
  };

  const bulkAddPartners = async (list) => {
    const existing = new Set(partners.map((p) => p.name));
    const seen = new Set();
    const toAdd = [];
    list.forEach((r) => {
      const nm = (r.name || "").trim();
      if (!nm || existing.has(nm) || seen.has(nm)) return;
      seen.add(nm);
      toAdd.push({ code: "P" + Date.now().toString().slice(-6) + toAdd.length, name: nm, type: r.type });
    });
    if (toAdd.length) {
      const { error } = await supabase.from("partner").insert(toAdd);
      if (error) throw error;
    }
    await loadAll();
    return { added: toAdd.length, skipped: list.length - toAdd.length };
  };

  const ALL_ITEMS = [
    { key: "현황", label: "수불 현황" }, { key: "출고", label: "출고 등록" },
    { key: "반납", label: "반납 등록" },
    { key: "확인", label: "입고확인" }, { key: "회수", label: "회수 관리" },
    { key: "재고", label: "재고 현황" }, { key: "AJ", label: "AJ 요청" }, { key: "EDI", label: "EDI 재고·정산" },
    { key: "마스터", label: "거래처" }, { key: "단가", label: "파렛트·단가" },
    { key: "사용자", label: "사용자 관리" }, { key: "설정", label: "내 설정" },
  ];
  const allowed = NAV_BY_ROLE[role] || ["현황"];
  const items = ALL_ITEMS.filter((it) => allowed.includes(it.key));
  const caps = capsOf(role);
  // 센터 목록(없으면 기본 3개) / 내가 출고·이동 가능한 센터(관리자=전체, 미배정=전체)
  const centerList = centers.length ? centers : CENTERS;
  const myCenters = role === "관리자" ? centerList : (myCenterCodes && myCenterCodes.length ? centerList.filter((c) => myCenterCodes.includes(c)) : centerList);

  // 현재 메뉴가 권한 밖이면 첫 허용 메뉴로 되돌림
  useEffect(() => {
    if (!loading && !allowed.includes(nav)) setNav(allowed[0] || "현황");
  }, [loading, role, nav]); // eslint-disable-line
  // 사용자 관리 진입 시 목록 로드
  useEffect(() => { if (nav === "사용자" && caps.users) loadUsers(); }, [nav, caps.users, loadUsers]);

  const partnersFull = partners.map((p) => ({ ...p, contracted: contracted[p.code] || [] }));

  if (blocked) return (
    <div style={{ minHeight: "100vh", background: C.page, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 30, marginBottom: 8 }}>🔒</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>비활성화된 계정입니다</h2>
        <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, margin: "0 0 18px" }}>이 계정은 관리자에 의해 접근이 차단되었어요. 사용이 필요하면 관리자에게 문의하세요.</p>
        <button onClick={() => supabase.auth.signOut()} style={{ ...btnTeal, justifyContent: "center", width: "100%" }}>로그아웃</button>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif", color: C.text, background: C.page }}>
      {/* 데스크톱 사이드바 */}
      <aside style={{ width: 176, background: C.dark, padding: "16px 12px", flexShrink: 0 }} className="lp-side">
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 16px" }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: C.teal, color: "#04342C", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 14 }}>L</div>
          <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>LETUS<span style={{ color: C.teal }}> PMS</span></span>
        </div>
        {items.map((it) => {
          const on = nav === it.key;
          return <button key={it.key} onClick={() => setNav(it.key)} style={{ display: "block", width: "100%", padding: "9px 12px", marginBottom: 3, borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, background: on ? C.dark2 : "transparent", color: on ? "#fff" : C.side }}>{it.label}</button>;
        })}
        <button onClick={() => setScanOpen(true)} style={{ display: "block", width: "100%", padding: "9px 12px", marginTop: 8, borderRadius: 8, border: `1px solid ${C.teal}`, cursor: "pointer", textAlign: "left", fontSize: 13, background: "transparent", color: C.teal }}>📷 QR 스캔</button>
        <div style={{ marginTop: 18, padding: "0 8px" }}>
          <button onClick={() => setNav("설정")} style={{ display: "block", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", marginBottom: 8 }}>
            <div style={{ color: "#6b7494", fontSize: 11 }}>{session.user.email}</div>
            <div style={{ color: C.teal, fontSize: 11 }}>{role} · 내 설정 ›</div>
          </button>
          <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 11, color: C.side, background: "transparent", border: "1px solid #3a4258", borderRadius: 6, padding: "5px 9px", cursor: "pointer" }}>로그아웃</button>
        </div>
      </aside>

      {/* 모바일 상단바 */}
      <div className="lp-topbar" style={{ display: "none", position: "fixed", top: 0, left: 0, right: 0, height: 52, background: C.dark, alignItems: "center", justifyContent: "space-between", padding: "0 14px", zIndex: 30 }}>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 16 }}>LETUS<span style={{ color: C.teal }}> PMS</span></span>
        <button onClick={() => setDrawerOpen(true)} aria-label="메뉴" style={{ background: "none", border: "none", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1 }}>☰</button>
      </div>

      {/* 모바일 드로어 */}
      {drawerOpen && (
        <div onClick={() => setDrawerOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 40 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 250, background: C.dark, padding: "16px 12px", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px 16px" }}>
              <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>LETUS<span style={{ color: C.teal }}> PMS</span></span>
              <button onClick={() => setDrawerOpen(false)} style={{ background: "none", border: "none", color: C.side, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            {items.map((it) => { const on = nav === it.key; return <button key={it.key} onClick={() => { setNav(it.key); setDrawerOpen(false); }} style={{ display: "block", width: "100%", padding: "13px 14px", marginBottom: 4, borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 15, background: on ? C.dark2 : "transparent", color: on ? "#fff" : C.side }}>{it.label}</button>; })}
            <button onClick={() => { setDrawerOpen(false); setScanOpen(true); }} style={{ display: "block", width: "100%", padding: "13px 14px", marginTop: 8, borderRadius: 8, border: `1px solid ${C.teal}`, cursor: "pointer", textAlign: "left", fontSize: 15, background: "transparent", color: C.teal }}>📷 QR 스캔</button>
            <div style={{ borderTop: "1px solid #3a4258", marginTop: 14, paddingTop: 14 }}>
              <div style={{ color: "#6b7494", fontSize: 12, padding: "0 8px 4px" }}>{session.user.email}</div>
              <div style={{ color: C.teal, fontSize: 12, padding: "0 8px 10px" }}>{role}</div>
              <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 13, color: C.side, background: "transparent", border: "1px solid #3a4258", borderRadius: 6, padding: "8px 12px", cursor: "pointer", width: "100%", textAlign: "left" }}>로그아웃</button>
            </div>
          </div>
        </div>
      )}

      <main className="lp-main" style={{ flex: 1, minWidth: 0, padding: "20px 18px 40px", overflow: "auto" }}>
        {loading ? <Splash text="데이터 불러오는 중…" /> : err ? (
          <div style={{ background: C.redBg, color: C.red, padding: 16, borderRadius: 10, fontSize: 13 }}>
            {err}<br /><br />혹시 supabase.js에 anon key를 안 넣었거나, 쓰기 권한(RLS) 설정이 필요할 수 있어요. 화면을 캡처해서 Claude에게 물어보세요.
          </div>
        ) : focusBatch ? (
          <QuickConfirm rows={ships.filter((s) => (s.batch_id || s.id) === focusBatch)} setStatus={setStatus} onClose={() => { setFocusBatch(null); window.history.replaceState({}, "", window.location.pathname); }} />
        ) : (
          <>
            {nav === "현황" && <Dashboard {...{ ships, ajReqs, flash, setStatus, setNav, caps, palletTypes, editShipment, cancelShipment, resetData, confirmAjSupply, resolveDiscrepancy }} />}
            {nav === "출고" && caps.outbound && <Outbound partners={partnersFull} palletTypes={palletTypes} ships={ships} ajReqs={ajReqs} centers={centerList} myCenters={myCenters} onRegister={register} onTransfer={transferCenters} onFree={registerFree} setNav={setNav} />}
            {nav === "반납" && caps.returnReg && <ReturnRegister partners={partnersFull} palletTypes={palletTypes} ships={ships} ajReqs={ajReqs} centers={centerList} onRegister={register} onAjReturn={createAjRequest} />}
            {nav === "확인" && <Confirm {...{ ships, setStatus, caps, ajReqs, confirmAjSupply }} />}
            {nav === "회수" && caps.operate && <Recovery {...{ ships, ajReqs, partners: partnersFull, palletTypes, centers: centerList, recoverToCenter, recoverToAj }} />}
            {nav === "재고" && caps.inventory && <InventoryScreen {...{ ships, ajReqs, partners: partnersFull, palletTypes, centers: centerList }} />}
            {nav === "AJ" && (caps.aj || caps.ajWorker) && <AjLink {...{ ajReqs, palletTypes, createAjRequest, completeAjRequest, confirmAjSupply, cancelAjRequest, ships, caps, centers: centerList }} />}
            {nav === "EDI" && caps.inventory && <EdiStock {...{ caps, ships, ajReqs, palletTypes, centers: centerList }} />}
            {nav === "단가" && caps.users && <PalletPricing caps={caps} />}
            {nav === "마스터" && <Master {...{ palletTypes, prices, partners: partnersFull, addPartner, bulkAddPartners, caps, setPrice, ships, ajReqs, deletePartner, centers, addCenter, toggleCenter }} />}
            {nav === "사용자" && caps.users && <Users {...{ users, partners: partnersFull, centers: centerList, setUserRole, setUserPartner, setUserActive, setUserCenters, adminResetPassword, meId: session.user.id }} />}
            {nav === "설정" && <Settings session={session} role={role} partners={partnersFull} />}
          </>
        )}
      </main>

      {scanOpen && <QrScanner onResult={(b) => { setScanOpen(false); setFocusBatch(b); }} onClose={() => setScanOpen(false)} />}

      <style>{`
        @media (max-width: 720px) {
          .lp-side { display: none !important; }
          .lp-topbar { display: flex !important; }
          .lp-main { padding-top: 64px !important; }
        }
      `}</style>
    </div>
  );
}

function Tabs({ tabs, tab, setTab, count }) {
  return (
    <div style={{ display: "flex", gap: 16, borderBottom: `1px solid ${C.border}`, marginBottom: 6, flexWrap: "wrap" }}>
      {tabs.map((t) => { const on = tab === t; return <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: "7px 2px", fontSize: 13, color: on ? C.text : C.sub, borderBottom: `2px solid ${on ? C.teal : "transparent"}` }}>{t} <span style={{ color: C.hint }}>{count(t)}</span></button>; })}
    </div>
  );
}

function Dashboard({ ships, ajReqs = [], flash, setStatus, setNav, caps = {}, palletTypes = [], editShipment, cancelShipment, resetData, confirmAjSupply, resolveDiscrepancy }) {
  const [tab, setTab] = useState("전체");
  const [edit, setEdit] = useState(null);
  const [slipBatch, setSlipBatch] = useState(null);
  const [disc, setDisc] = useState(null);
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const tabs = ["전체", "출고완료", "입고확인", "미회수"];
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = ships.filter((s) => (s.depart_at || "").slice(0, 10) === todayStr).reduce((a, s) => a + s.qty, 0);
  const unrec = ships.filter(isUnrecovered).reduce((a, s) => a + s.qty, 0);
  const waiting = ships.filter((s) => s.status === "출고완료").length;
  const discCount = ships.filter((s) => s.discrepancy).length;
  // 날짜 범위 필터(출고/반납일 기준)
  const inRange = (s) => { const d = (s.depart_at || "").slice(0, 10); if (from && d < from) return false; if (to && d > to) return false; return true; };
  const byTab = (s) => tab === "전체" ? true : tab === "미회수" ? isUnrecovered(s) : s.status === tab;
  // AJ 요청(공급/회수)도 수불 흐름이므로 같이 표시 — 가짜 행으로 변환
  const ajRows = ajReqs.map((r) => ({
    _aj: true, _raw: r, id: "aj_" + r.id, ajType: r.type, status: r.status, pallet_code: r.pallet_code, qty: r.qty,
    from: r.type === "회수" ? (r.partner_name || r.center || "—") : "AJ네트웍스",
    to: r.type === "회수" ? "AJ네트웍스" : (r.center || "—"),
    depart_at: r.requested_at, confirmed_at: r.completed_at, slip_no: "AJ",
  }));
  const shipFiltered = ships.filter((s) => inRange(s) && byTab(s));
  // AJ행은 '전체' 탭에서만 (상태가 출고완료/입고확인 체계와 다름)
  const ajFiltered = tab === "전체" ? ajRows.filter(inRange) : [];
  const filtered = [...shipFiltered, ...ajFiltered].sort((a, b) => (b.depart_at || "").localeCompare(a.depart_at || ""));
  const cnt = (t) => ships.filter(inRange).filter((s) => t === "전체" ? true : t === "미회수" ? isUnrecovered(s) : s.status === t).length + (t === "전체" ? ajRows.filter(inRange).length : 0);
  const quick = (days) => { const e = new Date(); const sdt = new Date(); sdt.setDate(e.getDate() - days); setFrom(sdt.toISOString().slice(0, 10)); setTo(e.toISOString().slice(0, 10)); };

  return (
    <>
      <Head title="수불 현황" sub={new Date().toLocaleDateString("ko-KR")} action={
        <div style={{ display: "flex", gap: 8 }}>
          {caps.users && <button onClick={resetData} style={{ fontSize: 12, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.red}`, background: "#fff", color: C.red, cursor: "pointer" }} title="테스트용 — 출고/반납 데이터 전체 삭제">🧪 초기화</button>}
          {caps.outbound && <button onClick={() => setNav("출고")} style={btnTeal}>+ 출고 등록</button>}
        </div>} />
      {flash && <div style={{ background: C.greenBg, color: C.green, fontSize: 13, padding: "9px 14px", borderRadius: 8, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span>✓ 등록 완료 — 전표 {flash.slip} 발행</span>
        {flash.batchId && <button onClick={() => setSlipBatch(flash.batchId)} style={{ ...btnTealSm, padding: "6px 12px" }}>🖨 전표 출력</button>}
      </div>}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Metric label="금일 출고" value={today} unit="장" tone="plain" />
        <Metric label="미회수 7일↑" value={unrec} unit="장" tone="danger" />
        <Metric label="입고확인 대기" value={waiting} unit="건" tone="warn" />
        <Metric label="수량상이" value={discCount} unit="건" tone={discCount ? "danger" : "plain"} />
      </div>
      {/* 날짜 조회 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <DateRange from={from} to={to} onApply={(f, t) => { setFrom(f); setTo(t); }} />
        <button onClick={() => quick(7)} style={btnGhost}>최근7일</button>
        <button onClick={() => quick(30)} style={btnGhost}>최근30일</button>
        {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} style={{ ...btnGhost, color: C.sub }}>전체</button>}
      </div>
      <Tabs tabs={tabs} tab={tab} setTab={setTab} count={cnt} />
      <div className="lp-table" style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>방향</Th><Th>상태</Th><Th>전표</Th><Th>유형</Th><Th r>수량</Th><Th>출고처</Th><Th>입고처</Th><Th>출고일시</Th><Th>입고확인</Th><Th>경과</Th><Th>조치</Th></tr></thead>
          <tbody>
            {filtered.map((s) => {
              if (s._aj) {
                const isRec = s.ajType === "회수";
                const st = s.status; // 요청 / 발송 / 완료
                const label = st === "완료" ? "AJ완료" : st === "발송" ? "발송됨" : "AJ요청";
                const sty = st === "완료" ? { bg: C.greenBg, fg: C.green } : st === "발송" ? { bg: C.blueBg, fg: C.blue } : { bg: C.amberBg, fg: C.amber };
                return (
                  <tr key={s.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <Td><span style={{ fontSize: 10, color: "#5b3aa6", background: "#efe8ff", padding: "1px 6px", borderRadius: 10 }}>{isRec ? "AJ회수" : "AJ공급"}</span></Td>
                    <Td><span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, background: sty.bg, color: sty.fg }}>{label}</span></Td>
                    <Td c={C.hint}>AJ</Td><Td>{s.pallet_code}</Td><Td r>{s.qty}</Td>
                    <Td>{s.from}</Td><Td>{s.to}</Td>
                    <Td c={C.sub}>{fmtDT(s.depart_at)}</Td>
                    <Td c={s.confirmed_at ? C.text : C.hint}>{fmtDT(s.confirmed_at)}</Td>
                    <Td c={C.hint}>—</Td>
                    <Td>
                      {st === "완료" ? <span style={{ color: C.green, fontSize: 11 }}>✓ 완료</span>
                        : (st === "발송" && !isRec && caps.aj) ? <button onClick={() => confirmAjSupply(s._raw)} style={btnGhost}>입고확인</button>
                        : <span style={{ color: C.hint, fontSize: 11 }}>{st === "발송" ? "센터 입고대기" : "AJ 처리 대기"}</span>}
                    </Td>
                  </tr>
                );
              }
              const danger = isUnrecovered(s); const d = daysSince(s.depart_at);
              return (
                <tr key={s.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td><DirBadge s={s} /></Td>
                  <Td><Pill status={danger ? "미회수" : s.status} /></Td>
                  <td style={{ padding: "11px 6px", fontSize: 12, color: C.sub }}>{s.slip_no}{s.vehicle_no ? <div style={{ fontSize: 10, color: C.hint }}>🚚 {s.vehicle_no}</div> : null}</td><Td>{s.pallet_code}</Td><Td r>{s.qty}</Td>
                  <Td>{fromOf(s)}</Td><Td>{toOf(s)}</Td>
                  <Td c={C.sub}>{fmtDT(s.depart_at)}</Td>
                  <Td c={s.confirmed_at ? C.text : C.hint}>{fmtDT(s.confirmed_at)}</Td>
                  <Td c={danger ? C.red : s.status === "회수완료" ? C.hint : C.text} b={danger}>{s.status === "회수완료" ? "—" : d + "일"}</Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {/* 입고확인: 협력업체는 본인 정방향만, 내부는 전체(반납 입고확인 포함). 회수·반납은 회수 관리에서 처리 */}
                      {s.status === "출고완료" && (caps.operate || (caps.confirmOwn && !isReturn(s))) && <button onClick={() => setNav("확인")} style={btnGhost} title="입고확인 화면에서 사진·서명 후 확인">입고확인</button>}
                      {s.status === "출고완료" && caps.confirmOwn && isReturn(s) && <span style={{ color: C.hint, fontSize: 11 }}>센터 확인 대기</span>}
                      {s.status === "입고확인" && !s.discrepancy && <span style={{ color: C.green, fontSize: 12 }}>✓ 완료</span>}
                      {s.discrepancy && <span style={{ fontSize: 11, color: C.amber, background: C.amberBg, padding: "2px 8px", borderRadius: 10 }}>⚠ 출고{s.qty}/입고{s.received_qty}</span>}
                      {s.discrepancy && caps.operate && <button onClick={() => setDisc(s)} style={btnTealSm}>해결</button>}
                      {s.discrepancy && s.receiver_phone && <a href={`tel:${s.receiver_phone}`} style={{ ...btnGhost, textDecoration: "none" }} title={`입고담당 ${s.receiver_name || ""} 연락`}>📞</a>}
                      {!isReturn(s) && !isMove(s) && <button onClick={() => setSlipBatch(s.batch_id || s.id)} style={{ ...btnGhost, color: C.sub }} title="전표 출력">🖨</button>}
                      {caps.operate && s.status === "출고완료" && <button onClick={() => setEdit(s)} style={{ ...btnGhost, color: C.sub }} title="수정·취소">⋯</button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={11} style={{ padding: "20px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>해당 조건의 건이 없어요.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 모바일 카드 뷰 */}
      <div className="lp-cards" style={{ display: "none", gap: 10 }}>
        {filtered.length === 0 && <div style={{ padding: 20, fontSize: 13, color: C.hint, textAlign: "center" }}>해당 조건의 건이 없어요.</div>}
        {filtered.map((s) => {
          if (s._aj) {
            const isRec = s.ajType === "회수"; const st = s.status;
            const label = st === "완료" ? "AJ완료" : st === "발송" ? "발송됨" : "AJ요청";
            const sty = st === "완료" ? { bg: C.greenBg, fg: C.green } : st === "발송" ? { bg: C.blueBg, fg: C.blue } : { bg: C.amberBg, fg: C.amber };
            return (
              <div key={s.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#5b3aa6", background: "#efe8ff", padding: "2px 7px", borderRadius: 10 }}>{isRec ? "AJ회수" : "AJ공급"}</span>
                    <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, background: sty.bg, color: sty.fg }}>{label}</span>
                  </div>
                  {st === "발송" && !isRec && caps.aj && <button onClick={() => confirmAjSupply(s._raw)} style={btnTealSm}>입고확인</button>}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{s.from} → {s.to}</div>
                <div style={{ fontSize: 13, color: C.sub }}>{s.pallet_code} · {s.qty}장 · {fmtDT(s.depart_at)}</div>
              </div>
            );
          }
          const danger = isUnrecovered(s); const d = daysSince(s.depart_at);
          return (
            <div key={s.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}><DirBadge s={s} /><Pill status={danger ? "미회수" : s.status} /></div>
                <span style={{ fontSize: 11, color: C.hint }}>{s.slip_no}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{fromOf(s)} → {toOf(s)}</div>
              <div style={{ fontSize: 14, marginBottom: 2 }}><b>{s.pallet_code}</b> · {s.qty}장{s.vehicle_no ? <span style={{ color: C.sub, fontWeight: 400 }}> · 🚚 {s.vehicle_no}</span> : ""}</div>
              <div style={{ fontSize: 12, color: C.sub }}>출고 {fmtDT(s.depart_at)}{s.confirmed_at ? ` · 입고 ${fmtDT(s.confirmed_at)}` : ""}{danger ? ` · 경과 ${d}일` : ""}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {s.status === "출고완료" && (caps.operate || (caps.confirmOwn && !isReturn(s))) && <button onClick={() => setNav("확인")} style={btnTealSm}>입고확인</button>}
                {s.status === "출고완료" && caps.confirmOwn && isReturn(s) && <span style={{ color: C.hint, fontSize: 12 }}>센터 확인 대기</span>}
                {s.status === "입고확인" && !s.discrepancy && <span style={{ color: C.green, fontSize: 12 }}>✓ 완료</span>}
                {s.discrepancy && <span style={{ fontSize: 12, color: C.amber, background: C.amberBg, padding: "3px 9px", borderRadius: 10 }}>⚠ 출고{s.qty}/입고{s.received_qty}</span>}
                {s.discrepancy && caps.operate && <button onClick={() => setDisc(s)} style={btnTealSm}>해결</button>}
                {s.discrepancy && s.receiver_phone && <a href={`tel:${s.receiver_phone}`} style={{ ...btnTealSm, background: "#fff", color: C.tealDk, border: `1px solid ${C.border}`, textDecoration: "none" }}>📞 연락</a>}
                {!isReturn(s) && !isMove(s) && <button onClick={() => setSlipBatch(s.batch_id || s.id)} style={btnGhost}>🖨 전표</button>}
                {caps.operate && s.status === "출고완료" && <button onClick={() => setEdit(s)} style={btnGhost}>수정·취소</button>}
              </div>
            </div>
          );
        })}
      </div>
      <style>{`@media (max-width: 720px) { .lp-table { display: none !important; } .lp-cards { display: grid !important; } }`}</style>
      <Note>날짜 범위로 조회할 수 있어요. 출고처→입고처 흐름, 출고·입고 시각이 함께 보입니다.</Note>
      {edit && <EditShipmentModal s={edit} palletTypes={palletTypes} onClose={() => setEdit(null)} onSave={editShipment} onCancel={cancelShipment} />}
      {slipBatch && <SlipPrint rows={ships.filter((s) => (s.batch_id || s.id) === slipBatch)} palletTypes={palletTypes} onClose={() => setSlipBatch(null)} />}
      {disc && <DiscrepancyModal s={disc} onClose={() => setDisc(null)} onResolve={resolveDiscrepancy} />}
    </>
  );
}

// 수량상이 해결 모달 — 사진 비교 + 담당자 연락 + 최종 수량 확정
function DiscrepancyModal({ s, onClose, onResolve }) {
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);
  const out = s.out_photos || []; const inp = s.in_photos || [];
  const resolve = async (q) => { setBusy(true); await onResolve(s, q); setBusy(false); onClose(); };
  const Thumbs = ({ list, label }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>{label} {list.length === 0 && <span style={{ color: C.hint }}>· 없음</span>}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {list.map((u, i) => <img key={i} src={u} alt="" onClick={() => setView(u)} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}`, cursor: "zoom-in" }} />)}
      </div>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: "100%", maxWidth: 460, maxHeight: "92vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>수량상이 해결</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 14 }}>{s.to_partner_name} · {s.slip_no} · {s.pallet_code}</div>

        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, background: C.tealBg, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}><div style={{ fontSize: 12, color: C.tealDk }}>출고 수량</div><div style={{ fontSize: 24, fontWeight: 700, color: C.tealDk }}>{s.qty}</div></div>
          <div style={{ flex: 1, background: C.amberBg, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}><div style={{ fontSize: 12, color: C.amber }}>입고 수량</div><div style={{ fontSize: 24, fontWeight: 700, color: C.amber }}>{s.received_qty}</div></div>
          <div style={{ flex: 1, background: C.page, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}><div style={{ fontSize: 12, color: C.sub }}>차이</div><div style={{ fontSize: 24, fontWeight: 700, color: C.red }}>{s.received_qty - s.qty > 0 ? "+" : ""}{s.received_qty - s.qty}</div></div>
        </div>

        {/* 입고담당자 연락 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}>
          <div style={{ fontSize: 13 }}><b>입고담당</b> {s.receiver_name || "—"}<div style={{ fontSize: 12, color: C.sub }}>{s.receiver_phone || "연락처 없음"}</div></div>
          {s.receiver_phone && <a href={`tel:${s.receiver_phone}`} style={{ ...btnTeal, textDecoration: "none" }}>📞 연락</a>}
        </div>

        {/* 사진 비교 */}
        <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
          <Thumbs list={out} label="출고 사진" />
          <Thumbs list={inp} label="입고 사진" />
        </div>

        <div style={{ fontSize: 12, color: C.hint, marginBottom: 10, lineHeight: 1.6 }}>사진 비교·통화로 협의 후, 맞는 수량으로 확정하세요. 확정 수량이 최종 재고에 반영돼요.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => resolve(s.qty)} disabled={busy} style={{ flex: 1, fontSize: 14, padding: "12px", borderRadius: 8, border: "none", background: busy ? "#c7cad1" : C.teal, color: "#fff", cursor: "pointer" }}>출고 {s.qty}장으로 확정</button>
          <button onClick={() => resolve(s.received_qty)} disabled={busy} style={{ flex: 1, fontSize: 14, padding: "12px", borderRadius: 8, border: "none", background: busy ? "#c7cad1" : C.amber, color: "#fff", cursor: "pointer" }}>입고 {s.received_qty}장으로 확정</button>
        </div>
      </div>
      {view && <div onClick={(e) => { e.stopPropagation(); setView(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, cursor: "zoom-out" }}><img src={view} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>}
    </div>
  );
}

// QR 이미지 (스캔 → 입고확인 링크)
function QrImg({ value, size = 88 }) {
  const [url, setUrl] = useState("");
  useEffect(() => { QRCode.toDataURL(value, { margin: 1, width: size * 2 }).then(setUrl).catch(() => setUrl("")); }, [value, size]);
  return url ? <img src={url} alt="QR" style={{ width: size, height: size }} /> : <div style={{ width: size, height: size }} />;
}

// 파렛트 이동전표 출력 (AJ 양식 4분할) — window.print()
function SlipPrint({ rows, onClose, palletTypes = [] }) {
  if (!rows.length) return null;
  const h = rows[0];
  const dateOf = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`; };
  const from = fromOf(h), to = toOf(h);
  const usageOf = (code) => palletTypes.find((p) => p.code === code)?.usage || "";
  const totalQty = rows.reduce((a, r) => a + (r.qty || 0), 0);
  const confirmUrl = `${window.location.origin}/?confirm=${h.batch_id || h.id}`;
  const copies = ["발송처용", "도착처용", "운송회사용", "보관용"];
  const Slip = ({ tag }) => (
    <div className="slip-copy" style={{ border: "1.5px solid #000", padding: 10, width: 252, fontSize: 11, color: "#000", fontFamily: "sans-serif", boxSizing: "border-box" }}>
      <div style={{ textAlign: "center", fontWeight: 700, fontSize: 15 }}>파렛트 이동전표</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, margin: "2px 1px 6px" }}>
        <span>전표 {h.slip_no}</span><span>({tag})</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <tbody>
          <tr><td style={cellH}>발송일</td><td style={cell}>{dateOf(h.depart_at)}</td><td style={cellH}>도착일</td><td style={cell}> </td></tr>
          <tr><td style={cellH}>발송처</td><td style={cell} colSpan={3}>{from}</td></tr>
          <tr><td style={cellH}>도착처</td><td style={cell} colSpan={3}>{to}</td></tr>
          <tr><td style={cellH}>차량정보</td><td style={cell} colSpan={3}>{h.vehicle_no || ""}</td></tr>
          <tr><td style={cellH}>유형</td><td style={cellH}>용도</td><td style={cellH} colSpan={2}>수량</td></tr>
          {rows.map((r, i) => (
            <tr key={i}><td style={cell}>{r.pallet_code}</td><td style={{ ...cell, fontSize: 10 }}>{usageOf(r.pallet_code)}</td><td style={cell} colSpan={2}>{r.qty}</td></tr>
          ))}
          <tr><td style={cellH} colSpan={2}>합계</td><td style={{ ...cell, fontWeight: 700 }} colSpan={2}>{totalQty} 장</td></tr>
          <tr><td style={cellH}>상태</td><td style={cell} colSpan={3}>☐ 정상   ☐ 파손   ☐ 수량상이</td></tr>
          <tr><td style={cellH}>비고</td><td style={cell} colSpan={3}>{h.note || ""}</td></tr>
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, marginTop: 4 }}>
        <tbody>
          <tr><td style={cellH}>출고확인</td><td style={cellH}>운송(기사)</td><td style={cellH}>인수확인</td></tr>
          <tr>
            <td style={{ ...cell, height: 42, verticalAlign: "bottom", fontSize: 8, position: "relative" }}>{h.out_sign_url && <img src={h.out_sign_url} alt="" style={{ position: "absolute", top: 2, left: "50%", transform: "translateX(-50%)", height: 22 }} />}{h.operator_name || ""}{h.operator_phone ? <><br />{h.operator_phone}</> : ""}</td>
            <td style={{ ...cell, height: 42, verticalAlign: "bottom" }}>(인)</td>
            <td style={{ ...cell, height: 42, verticalAlign: "bottom", fontSize: 8, position: "relative" }}>{h.in_sign_url && <img src={h.in_sign_url} alt="" style={{ position: "absolute", top: 2, left: "50%", transform: "translateX(-50%)", height: 22 }} />}{h.receiver_name || ""}{h.receiver_phone ? <><br />{h.receiver_phone}</> : ""}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <QrImg value={confirmUrl} size={70} />
        <div style={{ fontSize: 9, color: "#333", lineHeight: 1.4 }}>
          <b>QR 스캔 → 입고확인</b><br />받는 분이 폰으로 스캔하면<br />이 건 입고확인 화면이 떠요.
          {h.operator_phone && <><br />출고담당 {h.operator_phone}</>}
        </div>
      </div>
    </div>
  );
  return createPortal(
    <div className="slip-modal" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16, overflow: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: "95vw", maxHeight: "92vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }} className="no-print">
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>파렛트 이동전표</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => window.print()} style={btnTeal}>🖨 인쇄 / PDF</button>
            <button onClick={onClose} style={btnGhost}>닫기</button>
          </div>
        </div>
        <div id="slip-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {copies.map((t) => <Slip key={t} tag={t} />)}
        </div>
        <style>{`
          @page { size: A4 landscape; margin: 5mm; }
          @media print {
            #root { display: none !important; }
            .slip-modal { position: static !important; background: #fff !important; padding: 0 !important; display: block !important; overflow: visible !important; }
            .slip-modal > div { max-width: none !important; max-height: none !important; padding: 0 !important; border-radius: 0 !important; overflow: visible !important; }
            .slip-modal .no-print { display: none !important; }
            #slip-print { display: flex !important; flex-wrap: nowrap !important; gap: 2mm !important; width: 100%; justify-content: space-between !important; }
            #slip-print .slip-copy { width: 70mm !important; font-size: 9px !important; padding: 6px !important; }
          }
        `}</style>
      </div>
    </div>, document.body);
}
const cell = { border: "1px solid #000", padding: "3px 5px", textAlign: "center" };
const cellH = { border: "1px solid #000", padding: "3px 5px", textAlign: "center", fontWeight: 700, background: "#f0f0f0" };

function EditShipmentModal({ s, palletTypes, onClose, onSave, onCancel }) {
  const [pallet, setPallet] = useState(s.pallet_code);
  const [qty, setQty] = useState(s.qty);
  const [date, setDate] = useState((s.depart_at || "").slice(0, 10));
  const [note, setNote] = useState(s.note || "");
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const save = async () => {
    setBusy(true);
    // 날짜만 바꾸고 원래 시각은 유지
    const orig = new Date(s.depart_at || Date.now()); const [y, m, d] = date.split("-").map(Number); orig.setFullYear(y, m - 1, d);
    await onSave(s, { pallet_code: pallet, qty: Number(qty), depart_at: orig.toISOString(), note: note || null });
    setBusy(false); onClose();
  };
  const cancel = async () => {
    if (!window.confirm(`전표 ${s.slip_no} 출고를 취소할까요?\n(데이터는 삭제되지 않고 이력에 '취소'로 보존돼요)`)) return;
    setBusy(true); await onCancel(s); setBusy(false); onClose();
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>출고 수정</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: C.hint, marginBottom: 16 }}>{s.slip_no} · {s.to_partner_name}</div>

        <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>파렛트 유형</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {palletTypes.map((p) => { const on = pallet === p.code; return <button key={p.code} onClick={() => setPallet(p.code)} style={{ fontSize: 13, padding: "8px 12px", borderRadius: 7, cursor: "pointer", border: on ? `1px solid ${C.teal}` : `1px solid ${C.border}`, background: on ? C.tealBg : "#fff", color: on ? C.tealDk : C.text, fontWeight: on ? 600 : 400 }}>{p.code}</button>; })}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>수량</div>
            <input type="number" value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>출고일자</div>
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
          </div>
        </div>

        <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>메모</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={cancel} disabled={busy} style={{ fontSize: 13, padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.red}`, background: "#fff", color: C.red, cursor: "pointer" }}>출고 취소</button>
          <button onClick={save} disabled={busy} style={{ flex: 1, fontSize: 14, padding: "10px 14px", borderRadius: 8, border: "none", background: busy ? "#c7cad1" : C.teal, color: "#fff", cursor: "pointer" }}>{busy ? "저장 중…" : "저장"}</button>
        </div>
      </div>
    </div>
  );
}

// 여러 파렛트 유형 + 수량을 한 번에 입력 (혼합). maxOf 주면 그 한도까지만(보유수량 제한).
function PalletQtyEditor({ palletTypes, qtys, setQtys, color = C.teal, bg = C.tealBg, maxOf, maxLabel = "보유", hintOf, hintLabel = "EDI", imgOf }) {
  const [big, setBig] = useState(null);
  const set = (code, v) => setQtys((q) => ({ ...q, [code]: v }));
  return (
    <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
      {palletTypes.map((p) => {
        const max = maxOf ? maxOf(p.code) : Infinity;
        const disabled = !!maxOf && max <= 0;
        const v = qtys[p.code] || 0;
        return (
          <div key={p.code} style={{ display: "flex", alignItems: "center", gap: 10, opacity: disabled ? 0.4 : 1 }}>
            {imgOf && (imgOf(p.code) ? <img src={imgOf(p.code).image_url} alt={p.code} title={imgOf(p.code).name || p.code} referrerPolicy="no-referrer" onClick={() => setBig(imgOf(p.code))} style={{ width: 52, height: 40, objectFit: "contain", flexShrink: 0, cursor: "zoom-in", background: "#f6f7f9", borderRadius: 6 }} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span style={{ width: 52, flexShrink: 0 }} />)}
            <div style={{ width: 104, flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{p.code}</span>
              {imgOf && imgOf(p.code) && imgOf(p.code).name && <div style={{ fontSize: 10.5, color: C.hint, lineHeight: 1.3 }}>{imgOf(p.code).name}</div>}
              {maxOf && <span style={{ fontSize: 11, color: max <= 0 ? C.red : C.hint }}> · {maxLabel} {max}</span>}
              {hintOf && hintOf(p.code) !== null && <span style={{ fontSize: 11, color: v > hintOf(p.code) ? C.red : C.hint }}> · {hintLabel} {hintOf(p.code).toLocaleString()}</span>}
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", border: `1px solid ${v > 0 ? color : C.border}`, borderRadius: 8, padding: "4px 12px", background: v > 0 ? bg : "#fff" }}>
              <button disabled={disabled} onClick={() => set(p.code, Math.max(0, v - 1))} style={{ background: "none", border: "none", fontSize: 20, color: C.sub, cursor: "pointer" }}>−</button>
              <input type="number" value={v} disabled={disabled} onChange={(e) => { let n = Math.max(0, parseInt(e.target.value) || 0); if (max !== Infinity) n = Math.min(n, max); set(p.code, n); }} style={{ width: 56, textAlign: "center", fontSize: 16, fontWeight: 600, border: "none", outline: "none", background: "transparent" }} />
              <button disabled={disabled || v >= max} onClick={() => set(p.code, Math.min(max, v + 1))} style={{ background: "none", border: "none", fontSize: 20, color, cursor: disabled || v >= max ? "default" : "pointer" }}>+</button>
            </div>
          </div>
        );
      })}
      {big && <div onClick={() => setBig(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
        <div style={{ background: "#fff", borderRadius: 12, padding: 16, maxWidth: "90vw", textAlign: "center" }}>
          <img src={big.image_url} alt={big.code} referrerPolicy="no-referrer" style={{ maxWidth: "80vw", maxHeight: "65vh", objectFit: "contain" }} />
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8 }}>{big.code} {big.name ? "· " + big.name : ""}</div>
          {(big.width_mm || big.depth_mm) && <div style={{ fontSize: 12, color: C.sub }}>{[big.width_mm, big.depth_mm, big.height_mm].filter(Boolean).join(" × ")} mm{big.weight_kg ? " · " + big.weight_kg + "kg" : ""}</div>}
        </div>
      </div>}
    </div>
  );
}
// 파렛트·단가(aj_pallet)의 이미지·이름 (유형 헷갈림 방지)
function usePalletInfo() {
  const [m, setM] = useState({});
  useEffect(() => { supabase.from("aj_pallet").select("code,name,image_url,width_mm,depth_mm,height_mm,weight_kg").then(({ data }) => { const o = {}; (data || []).forEach((r) => { if (r.image_url) o[r.code] = r; }); setM(o); }); }, []);
  return m;
}
const qtysToLines = (qtys) => Object.entries(qtys).map(([pallet, qty]) => ({ pallet, qty: qty || 0 })).filter((l) => l.qty > 0);
const qtysTotal = (qtys) => Object.values(qtys).reduce((a, n) => a + (n || 0), 0);

// 현장 사진 촬영·업로드 (Supabase Storage 'pallet-photos')
// Storage 업로드 (File/Blob 배열 → URL 배열)
async function uploadPhotos(files) {
  const urls = [];
  for (const f of files) {
    const path = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await supabase.storage.from("pallet-photos").upload(path, f, { contentType: f.type || "image/jpeg" });
    if (error) throw error;
    urls.push(supabase.storage.from("pallet-photos").getPublicUrl(path).data.publicUrl);
  }
  return urls;
}

function PhotoCapture({ photos = [], setPhotos, label = "현장 사진", hint = "차량 좌/우 + 차량번호", color = C.teal }) {
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState(false);
  const [view, setView] = useState(null);
  const addFiles = async (files) => {
    if (!files.length) return;
    setBusy(true);
    try { const urls = await uploadPhotos(files); setPhotos((prev) => [...(prev || []), ...urls]); }
    catch (err) { alert("사진 업로드 실패: " + (err.message || err) + "\n(pallet-photos 버킷이 생성됐는지 확인)"); }
    setBusy(false);
  };
  const onPick = (e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; };
  return (
    <div>
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{label} <span style={{ color: C.hint, fontSize: 11 }}>· {hint}</span>{(photos || []).length > 0 && <span style={{ color, fontSize: 11, fontWeight: 600 }}> · {photos.length}장</span>}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        {(photos || []).map((u, i) => (
          <div key={i} style={{ position: "relative" }}>
            <img src={u} alt="" onClick={() => setView(u)} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}`, cursor: "zoom-in" }} />
            <button type="button" onClick={(e) => { e.stopPropagation(); setPhotos((photos || []).filter((_, j) => j !== i)); }} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: "none", background: C.red, color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>
        ))}
      </div>
      {view && <div onClick={() => setView(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, cursor: "zoom-out" }}><img src={view} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setCam(true)} style={{ fontSize: 13, padding: "8px 14px", borderRadius: 8, border: `1px solid ${color}`, background: "#fff", color, cursor: "pointer" }}>📷 촬영</button>
        <label style={{ fontSize: 13, padding: "8px 14px", borderRadius: 8, border: `1px dashed ${C.border}`, background: "#fff", color: C.sub, cursor: "pointer" }}>
          {busy ? "업로드 중…" : "🖼 첨부"}
          <input type="file" accept="image/*" multiple onChange={onPick} style={{ display: "none" }} />
        </label>
      </div>
      {cam && <CameraModal color={color} onShot={(blob) => addFiles([new File([blob], "shot.jpg", { type: "image/jpeg" })])} onClose={() => setCam(false)} count={(photos || []).length} />}
    </div>
  );
}

// 전자 서명 패드 — 그리고 '서명 적용'하면 업로드 후 onSave(url)
function SignaturePad({ onSave, label = "서명", color = C.teal }) {
  const ref = useRef(null); const drawing = useRef(false); const timer = useRef(null); const dirty = useRef(false);
  const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const pos = (e) => { const c = ref.current; const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) }; };
  const apply = async () => {
    if (!dirty.current) return;
    setBusy(true);
    try { const blob = await new Promise((r) => ref.current.toBlob(r, "image/png")); const urls = await uploadPhotos([new File([blob], "sign.png", { type: "image/png" })]); onSave && onSave(urls[0]); setDone(true); }
    catch (e) { /* 조용히 무시, 재시도 가능 */ }
    setBusy(false);
  };
  const start = (e) => { drawing.current = true; dirty.current = true; if (timer.current) clearTimeout(timer.current); const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#111"; ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => { if (!drawing.current) return; drawing.current = false; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(apply, 500); }; // 손 떼면 자동 저장
  const clear = () => { const c = ref.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); dirty.current = false; setDone(false); onSave && onSave(null); };
  return (
    <div>
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{label} <span style={{ color: C.hint, fontSize: 11 }}>· 사인하면 자동 저장</span> {busy && <span style={{ color: C.hint, fontSize: 11 }}>저장 중…</span>}{done && !busy && <span style={{ color, fontSize: 11, fontWeight: 600 }}>· 서명됨 ✓</span>}</div>
      <canvas ref={ref} width={280} height={90} onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ width: "100%", maxWidth: 280, height: 90, border: `1px solid ${done ? color : C.border}`, borderRadius: 8, touchAction: "none", background: "#fff", display: "block" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button type="button" onClick={clear} style={{ ...btnGhost, padding: "6px 12px" }}>지우기</button>
      </div>
    </div>
  );
}

// 앱 내 QR 스캐너 — 카메라로 QR 인식 → onResult(batchId)
function QrScanner({ onResult, onClose }) {
  const videoRef = useRef(null); const streamRef = useRef(null); const raf = useRef(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let active = true; const canvas = document.createElement("canvas");
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => {
        if (!active) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s; const v = videoRef.current; if (!v) return; v.srcObject = s; v.play();
        const tick = () => {
          if (!active || !v.videoWidth) { raf.current = requestAnimationFrame(tick); return; }
          canvas.width = v.videoWidth; canvas.height = v.videoHeight;
          const ctx = canvas.getContext("2d"); ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code && code.data) {
            const m = code.data.match(/confirm=([\w-]+)/);
            if (m) { active = false; onResult(m[1]); return; }
          }
          raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      })
      .catch((e) => setErr("카메라를 열 수 없어요: " + (e.message || e)));
    return () => { active = false; if (raf.current) cancelAnimationFrame(raf.current); if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 85, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" }}>
        {err ? <div style={{ color: "#fff", fontSize: 14, padding: 24, textAlign: "center" }}>{err}</div>
          : <><video ref={videoRef} autoPlay playsInline muted style={{ maxWidth: "100%", maxHeight: "100%" }} />
            <div style={{ position: "absolute", width: 220, height: 220, border: "3px solid #1D9E75", borderRadius: 16, boxShadow: "0 0 0 9999px rgba(0,0,0,.35)" }} /></>}
      </div>
      <div style={{ padding: "16px 20px", background: "#111", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#fff", fontSize: 13 }}>전표 QR을 사각형 안에 비추세요</span>
        <button onClick={onClose} style={{ fontSize: 14, padding: "10px 16px", borderRadius: 8, border: "1px solid #555", background: "transparent", color: "#fff", cursor: "pointer" }}>닫기</button>
      </div>
    </div>
  );
}

// 라이브 카메라 — 촬영 버튼으로 연속 촬영, 종료까지 계속 업로드
function CameraModal({ onShot, onClose, color = C.teal, count = 0 }) {
  const videoRef = useRef(null); const streamRef = useRef(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => { if (!active) { s.getTracks().forEach((t) => t.stop()); return; } streamRef.current = s; if (videoRef.current) { videoRef.current.srcObject = s; } })
      .catch((e) => setErr("카메라를 열 수 없어요: " + (e.message || e) + " — '첨부'로 올려주세요."));
    return () => { active = false; if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop()); };
  }, []);
  const snap = async () => {
    const v = videoRef.current; if (!v || !v.videoWidth) return;
    const cv = document.createElement("canvas"); cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext("2d").drawImage(v, 0, 0);
    setBusy(true);
    await new Promise((res) => cv.toBlob(async (b) => { if (b) { await onShot(b); } res(); }, "image/jpeg", 0.85));
    setBusy(false);
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 80, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {err ? <div style={{ color: "#fff", fontSize: 14, padding: 24, textAlign: "center" }}>{err}</div>
          : <video ref={videoRef} autoPlay playsInline muted style={{ maxWidth: "100%", maxHeight: "100%" }} />}
      </div>
      <div style={{ padding: "16px 20px", background: "#111", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ color: "#fff", fontSize: 13 }}>촬영 {count}장</span>
        <button type="button" onClick={snap} disabled={!!err || busy} style={{ width: 64, height: 64, borderRadius: 32, border: "4px solid #fff", background: busy ? "#888" : color, cursor: "pointer", fontSize: 22 }}>📷</button>
        <button type="button" onClick={onClose} style={{ fontSize: 14, padding: "10px 16px", borderRadius: 8, border: "1px solid #555", background: "transparent", color: "#fff", cursor: "pointer" }}>촬영 종료</button>
      </div>
    </div>
  );
}

function Outbound({ partners, palletTypes, ships = [], ajReqs = [], centers = CENTERS, myCenters = CENTERS, onRegister, onTransfer, onFree, setNav }) {
  const today = new Date().toISOString().slice(0, 10);
  const [dir, setDir] = useState("자유");
  const [q, setQ] = useState(""); const [sel, setSel] = useState(null);
  const [qtys, setQtys] = useState({});
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(today); const [note, setNote] = useState(""); const [center, setCenter] = useState(myCenters[0] || centers[0]); const [toCenter, setToCenter] = useState(centers.find((c) => c !== (myCenters[0] || centers[0])) || centers[0]);
  const [photos, setPhotos] = useState([]); const [vehicleNo, setVehicleNo] = useState(""); const [slipRows, setSlipRows] = useState(null); const [outSign, setOutSign] = useState(null);
  const matches = partners.filter((p) => p.name.includes(q) || (p.type || "").includes(q)).slice(0, 6);
  const pick = (p) => { setSel(p); setQ(""); setOpen(false); };
  const isRet = dir === "반납"; const isMv = dir === "이동"; const isFree = dir === "자유";
  const { idx: ediIdx } = useEdiIndex();
  const pinfoOut = usePalletInfo();
  const wpList = useMemo(() => (ediIdx ? ediIdx.wps.filter((w) => w.no > 0 && !w.closed) : []), [ediIdx]);
  const [fromNo, setFromNo] = useState(null); const [toNo, setToNo] = useState(null);
  const fromWp = wpList.find((w) => w.no === fromNo) || null, toWp = wpList.find((w) => w.no === toNo) || null;
  const srcWp = isFree ? fromWp : ediIdx ? ediIdx.wpByCenter[center] : null; // 보내는 작업장 (반납은 거래처라 한도 없음)
  const fromStock = useWpStock(isRet ? null : srcWp, ships, ediIdx);
  const hintOf = fromStock ? (code) => fromStock.items[code] || 0 : undefined;
  const total = qtysTotal(qtys);
  const reset = () => { setQtys({}); setNote(""); setDate(today); setPhotos([]); setVehicleNo(""); setOutSign(null); };
  // 출고/이동은 출발 센터 재고 한도 내. 반납(거래처→센터)은 한도 없음.
  useEffect(() => { setQtys({}); }, [center, dir]);
  const themeColor = isRet ? C.amber : isMv ? "#5b3aa6" : isFree ? C.blue : C.teal;
  const themeBg = isRet ? C.amberBg : isMv ? "#efe8ff" : isFree ? C.blueBg : C.tealBg;
  const canSubmit = total > 0 && !busy && (isFree ? !!fromWp && !!toWp && fromNo !== toNo : isMv ? center !== toCenter : !!sel);
  const submit = async () => {
    if (!photos.length) { alert("현장 사진을 촬영/첨부한 후 등록해주세요."); return; }
    if (!outSign) { alert("서명을 완료한 후 등록해주세요. (사인 후 손을 떼면 자동 저장돼요)"); return; }
    if (hintOf) {
      const over = qtysToLines(qtys).filter((l) => l.qty > hintOf(l.pallet));
      if (over.length && !window.confirm("현재고(EDI 기준)보다 많아요:\n" + over.map((l) => `${l.pallet} 요청 ${l.qty}장 / 현재고 ${hintOf(l.pallet)}장`).join("\n") + "\n\n실물이 있으면 그대로 등록할까요?")) return;
    }
    setBusy(true);
    const rows = isFree ? await onFree(fromWp, toWp, qtysToLines(qtys), date, note, photos, vehicleNo, outSign)
      : isMv ? await onTransfer(center, toCenter, qtysToLines(qtys), photos, vehicleNo, note, outSign)
      : await onRegister(sel, qtysToLines(qtys), date, note, dir, center, photos, vehicleNo, outSign);
    setBusy(false); reset();
    if (rows && rows.length) setSlipRows(rows); // 등록 직후 전표 바로 출력
  };

  return (
    <>
      <Head title="출고 등록" sub="방향을 고르고, 거래처·여러 유형·수량 입력" />
      <div style={{ maxWidth: 480, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>방향</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 18, background: "#eef0f3", borderRadius: 10, padding: 4 }}>
          {[["자유", "출고처 → 입고처"], ["출고", "센터→거래처"], ["반납", "반납"], ["이동", "센터이동"]].map(([v, label]) => (
            <button key={v} onClick={() => setDir(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: dir === v ? (v === "반납" ? C.amber : v === "이동" ? "#5b3aa6" : v === "자유" ? C.blue : C.teal) : "transparent", color: dir === v ? "#fff" : C.sub }}>{label}</button>
          ))}
        </div>

        {isFree ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>출고처 <span style={{ color: C.hint, fontSize: 11 }}>· 보내는 곳 · EDI 작업장 전체 검색 (센터·시공팀·업체)</span></div>
            <WorkplacePicker wps={wpList} value={fromNo} onChange={setFromNo} width="100%" placeholder={ediIdx ? "보내는 곳 (이름·번호)" : "작업장 목록 불러오는 중…"} />
            {fromStock && <div style={{ fontSize: 11.5, color: C.sub, marginTop: 5 }}>현재고(EDI {(fromStock.date || "").slice(5)} 기준 + 당일 이동·PMS 예정): {Object.keys(fromStock.items).length ? Object.entries(fromStock.items).map(([k, v]) => k + " " + v.toLocaleString()).join(" · ") : "없음"}</div>}
            <div style={{ textAlign: "center", color: C.hint, margin: "6px 0" }}>↓</div>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>입고처 <span style={{ color: C.hint, fontSize: 11 }}>· 받는 곳</span></div>
            <WorkplacePicker wps={wpList} value={toNo} onChange={setToNo} width="100%" filter={(w) => w.no !== fromNo} placeholder="받는 곳 (이름·번호)" />
            {fromWp && toWp && <div style={{ fontSize: 11.5, color: C.blue, marginTop: 6 }}>{ediClean(fromWp.name)} → {ediClean(toWp.name)} · EDI 반영 탭에서 출고처 "{ediClean(fromWp.name)}"로 자동입력돼요</div>}
          </div>
        ) : isMv ? (
          <div style={{ display: "flex", gap: 10, marginBottom: 18, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>출발 센터</div>
              <select value={center} onChange={(e) => setCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }}>{myCenters.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </div>
            <div style={{ paddingBottom: 10, color: C.hint }}>→</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>도착 센터</div>
              <select value={toCenter} onChange={(e) => setToCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${center === toCenter ? C.red : C.border}`, borderRadius: 8 }}>{centers.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>거래처 <span style={{ color: C.hint, fontSize: 11 }}>· 검색</span></div>
            {!sel ? (
              <div style={{ position: "relative", marginBottom: 18 }}>
                <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} placeholder="예: 쿠팡, 시공팀, 이케아…" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
                {open && (
                  <div style={{ position: "absolute", top: 44, left: 0, right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 5, maxHeight: 240, overflow: "auto" }}>
                    {matches.length === 0 && <div style={{ padding: "10px 12px", fontSize: 13, color: C.hint }}>일치하는 거래처 없음</div>}
                    {matches.map((p) => (
                      <button key={p.code} onMouseDown={(e) => { e.preventDefault(); pick(p); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", border: "none", borderBottom: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", textAlign: "left" }}>
                        <span style={{ fontSize: 13 }}>{p.name}</span>
                        <TypeBadge t={p.type} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: `1px solid ${C.teal}`, background: C.tealBg, borderRadius: 8, padding: "10px 12px", marginBottom: 18 }}>
                <span style={{ fontSize: 14, color: C.tealDk, fontWeight: 600 }}>{sel.name} <span style={{ fontSize: 11, fontWeight: 400 }}>· {sel.type}</span></span>
                <button onClick={() => setSel(null)} style={{ background: "none", border: "none", cursor: "pointer", color: C.tealDk, fontSize: 16 }}>✕</button>
              </div>
            )}

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isRet ? "반납 받는 센터" : "출고하는 센터"}</div>
            <select value={center} onChange={(e) => setCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }}>
              {myCenters.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형·수량 <span style={{ color: C.hint, fontSize: 11 }}>· {isRet ? "여러 종류 한 번에" : "현재고(EDI 기준)보다 많으면 빨갛게 표시"}</span></div>
        <PalletQtyEditor palletTypes={palletTypes} qtys={qtys} setQtys={setQtys} color={themeColor} bg={themeBg} hintOf={isRet ? undefined : hintOf} hintLabel="현재고" imgOf={(c) => pinfoOut[c] || null} />
        {total > 0 && <div style={{ fontSize: 12, color: C.sub, marginBottom: 14, textAlign: "right" }}>합계 <b style={{ color: C.text }}>{total}</b>장</div>}

        {!isMv && (
          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isRet ? "반납일자" : isFree ? "이동일자" : "출고일자"}</div>
              <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
            </div>
          </div>
        )}

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>차량번호</div>
        <input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="예: 12가 3456" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }} />

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>메모 <span style={{ color: C.hint, fontSize: 11 }}>· 선택</span></div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="기사명, 특이사항 등" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

        <div style={{ marginBottom: 18 }}><PhotoCapture photos={photos} setPhotos={setPhotos} label={isMv || isFree ? "이동 현장 사진" : isRet ? "반납 현장 사진" : "출고 현장 사진"} color={themeColor} /></div>

        <div style={{ marginBottom: 18 }}><SignaturePad onSave={setOutSign} label={isMv ? "출고 담당 서명" : isRet ? "반납자 서명" : "출고자 서명"} color={themeColor} /></div>

        <button disabled={!canSubmit} onClick={submit} style={{ width: "100%", background: !canSubmit ? "#c7cad1" : themeColor, color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "처리 중…" : isRet ? "반납 등록" : isMv ? "센터 이동" : isFree ? "작업장 간 이동 등록" : "출고 등록"}</button>
        <p style={{ textAlign: "center", fontSize: 11, color: C.hint, marginTop: 10 }}>{isRet ? "거래처가 우리에게 돌려준 파렛트를 기록해요" : isFree ? "아무 작업장 → 아무 작업장. 센터·거래처로 연결된 곳이면 출고/반납/센터이동으로 자동 분류돼요" : isMv ? "센터 간 재고를 옮겨요 (출발 −, 도착 +)" : "등록 즉시 전표 자동 발행 · Supabase에 저장"}</p>
      </div>
      {slipRows && <SlipPrint rows={slipRows} palletTypes={palletTypes} onClose={() => { setSlipRows(null); setNav && setNav("현황"); }} />}
    </>
  );
}

// 협력업체용 반납 등록 — 본인 보유 수량 한도 내에서, 여러 유형 한 번에, 받는 센터 지정
function ReturnRegister({ partners, palletTypes, ships, ajReqs = [], centers = CENTERS, onRegister, onAjReturn }) {
  const today = new Date().toISOString().slice(0, 10);
  const me = partners[0]; // 협력업체는 RLS로 본인 거래처만 보임
  const [qtys, setQtys] = useState({});
  const [date, setDate] = useState(today); const [note, setNote] = useState(""); const [center, setCenter] = useState(centers[0]); const [busy, setBusy] = useState(false);
  const [dest, setDest] = useState("센터"); // 센터 / AJ
  const isAj = dest === "AJ";
  const heldOf = (code) => (me ? availableToRecover(ships, ajReqs, me.code, code) : 0);
  const totalHeld = palletTypes.reduce((a, p) => a + heldOf(p.code), 0);
  const total = qtysTotal(qtys);
  const submit = async () => {
    setBusy(true);
    if (isAj) await onAjReturn({ type: "회수", lines: qtysToLines(qtys), partner: me, note });
    else await onRegister(me, qtysToLines(qtys), date, note, "반납", center);
    setBusy(false); setNote(""); setDate(today); setQtys({});
  };
  return (
    <>
      <Head title="반납 등록" sub="보유 중인 파렛트를 센터로 반납하거나 AJ로 회수하세요" />
      <div style={{ maxWidth: 480, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        {!me ? (
          <div style={{ fontSize: 13, color: C.amber, background: C.amberBg, padding: "12px 14px", borderRadius: 8 }}>아직 소속 거래처가 연결되지 않았어요. 관리자에게 문의하세요.</div>
        ) : totalHeld === 0 ? (
          <div style={{ fontSize: 13, color: C.sub, background: C.page, padding: "16px", borderRadius: 8, textAlign: "center" }}>현재 보유 중인(반납 가능) 파렛트가 없어요.</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>반납 주체</div>
            <div style={{ border: `1px solid ${C.amber}`, background: C.amberBg, borderRadius: 8, padding: "10px 12px", marginBottom: 16, fontSize: 14, color: C.amber, fontWeight: 600 }}>{me.name}</div>

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>회수 방향</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, background: "#eef0f3", borderRadius: 10, padding: 4 }}>
              {[["센터", "센터로 반납"], ["AJ", "AJ로 회수"]].map(([v, label]) => (
                <button key={v} onClick={() => setDest(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: dest === v ? (v === "AJ" ? "#7a4ad8" : C.teal) : "transparent", color: dest === v ? "#fff" : C.sub }}>{label}</button>
              ))}
            </div>

            {isAj ? (
              <div style={{ border: `1px solid #c9b6f0`, background: "#f3eeff", borderRadius: 8, padding: "10px 12px", marginBottom: 18, fontSize: 13, color: "#5b3aa6" }}>AJ네트웍스로 회수 요청돼요. AJ 직원이 확인하면 처리 완료됩니다. (우리 센터 재고로 들어오지 않아요)</div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>받는 센터</div>
                <select value={center} onChange={(e) => setCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }}>
                  {centers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </>
            )}

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isAj ? "회수" : "반납"} 수량 <span style={{ color: C.hint, fontSize: 11 }}>· 보유 한도 내</span></div>
            <PalletQtyEditor palletTypes={palletTypes.filter((p) => heldOf(p.code) > 0)} qtys={qtys} setQtys={setQtys} color={isAj ? "#7a4ad8" : C.amber} bg={isAj ? "#f3eeff" : C.amberBg} maxOf={heldOf} />
            {total > 0 && <div style={{ fontSize: 12, color: C.sub, marginBottom: 14, textAlign: "right" }}>합계 <b style={{ color: C.text }}>{total}</b>장</div>}

            {!isAj && (
              <>
                <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>반납일자</div>
                <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }} />
              </>
            )}

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>메모 <span style={{ color: C.hint, fontSize: 11 }}>· 선택</span></div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="차량번호, 특이사항 등" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

            <button disabled={total === 0 || busy || !wp} onClick={submit} style={{ width: "100%", background: (total === 0 || busy) ? "#c7cad1" : (isAj ? "#7a4ad8" : C.amber), color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "등록 중…" : isAj ? "AJ 회수요청" : "센터 반납 등록"}</button>
            <p style={{ textAlign: "center", fontSize: 11, color: C.hint, marginTop: 10 }}>{isAj ? "AJ 직원이 확인하면 AJ로 회수 처리돼요" : "센터에서 입고확인 후 우리 재고로 정리돼요"}</p>
          </>
        )}
      </div>
    </>
  );
}

function Confirm({ ships, setStatus, caps = {}, ajReqs = [], confirmAjSupply }) {
  // 협력업체: 우리가 보낸(정방향 출고)을 받았다고 확인 / 내부: 거래처가 보낸(반납)·센터이동·AJ공급을 입고확인
  const pending = ships.filter((s) => s.status === "출고완료" && (caps.confirmOwn ? !isReturn(s) : true));
  const ajInbound = !caps.confirmOwn ? ajReqs.filter((r) => r.type === "공급" && r.status === "발송") : [];
  const sub = caps.confirmOwn ? "우리쪽에서 보낸 파렛트를 받으셨으면 확인하세요" : "거래처 반납·센터이동·AJ공급 등 들어오는 입고를 확인하세요";
  const nothing = pending.length === 0 && ajInbound.length === 0;
  return (
    <>
      <Head title="입고확인" sub={sub} />
      {nothing ? <div style={{ padding: 40, textAlign: "center", color: C.hint, fontSize: 13 }}>확인 대기 중인 건이 없어요.</div> : (
        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          {ajInbound.map((r) => (
            <div key={r.id} style={{ background: C.card, border: `1px solid ${C.teal}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 10, color: "#5b3aa6", background: "#efe8ff", padding: "1px 6px", borderRadius: 10 }}>AJ공급</span>AJ네트웍스 → {r.center}</div>
                <div style={{ fontSize: 12, color: C.sub }}>{r.pallet_code} · {r.qty}장 · 발송 {fmtDT(r.sent_at)}</div>
              </div>
              <button onClick={() => confirmAjSupply(r)} style={btnTeal}>✓ 입고확인</button>
            </div>
          ))}
          {pending.map((s) => <ConfirmCard key={s.id} s={s} setStatus={setStatus} />)}
        </div>
      )}
      <Note>{caps.confirmOwn ? "확인하면 우리 장부에 즉시 반영돼요. 받은 파렛트 사진을 함께 남기면 증빙이 돼요." : "입고확인하면 센터/거래처 재고에 즉시 반영돼요. 사진을 남기면 증빙이 됩니다."}</Note>
    </>
  );
}

// QR 스캔 입고확인 — 해당 전표(batch) 건만 모아서 확인
function QuickConfirm({ rows, setStatus, onClose }) {
  const pending = rows.filter((s) => s.status === "출고완료");
  const done = rows.filter((s) => s.status !== "출고완료");
  return (
    <>
      <Head title="📷 QR 입고확인" sub={rows.length ? `전표 ${rows[0].slip_no} · ${fromOf(rows[0])} → ${toOf(rows[0])}` : ""} action={<button onClick={onClose} style={btnGhost}>닫기</button>} />
      {rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.hint, fontSize: 13, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12 }}>해당 전표를 찾을 수 없어요.<br />이미 처리됐거나, 이 계정 권한 밖의 건일 수 있어요.</div>
      ) : (
        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          {pending.length === 0 && <div style={{ background: C.greenBg, color: C.green, fontSize: 14, fontWeight: 600, padding: 16, borderRadius: 12, textAlign: "center" }}>✓ 이 전표는 모두 입고확인 완료됐어요.</div>}
          {pending.map((s) => <ConfirmCard key={s.id} s={s} setStatus={setStatus} />)}
          {done.length > 0 && <Note>이미 입고확인된 건: {done.map((s) => `${s.pallet_code} ${s.qty}장`).join(", ")}</Note>}
        </div>
      )}
    </>
  );
}

// 입고확인 카드 — 사진 촬영(선택) 후 확인
function ConfirmCard({ s, setStatus }) {
  const [photos, setPhotos] = useState([]);
  const [sign, setSign] = useState(null);
  const [recv, setRecv] = useState(s.qty);
  const mismatch = Number(recv) !== s.qty;
  const confirm = () => {
    if (!photos.length) { alert("입고 사진을 촬영/첨부한 후 확인해주세요."); return; }
    if (!sign) { alert("인수자 서명을 완료한 후 확인해주세요. (사인 후 손을 떼면 자동 저장돼요)"); return; }
    if (mismatch && !window.confirm(`보낸 수량 ${s.qty}장과 받은 수량 ${recv}장이 달라요.\n수량상이로 등록하고 보낸 쪽에 확인 요청할까요?`)) return;
    setStatus(s, "입고확인", "입고확인", photos, sign, Number(recv));
  };
  return (
    <div style={{ background: C.card, border: `1px solid ${mismatch ? C.amber : C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><DirBadge s={s} />{fromOf(s)} → {toOf(s)}</div>
          <div style={{ fontSize: 13, color: C.sub }}>{s.slip_no} · {s.pallet_code} · 보낸 {s.qty}장{s.vehicle_no ? ` · 🚚${s.vehicle_no}` : ""}{s.note ? ` · ${s.note}` : ""}</div>
        </div>
        <button onClick={confirm} style={btnTeal}>✓ 입고확인</button>
      </div>
      <div style={{ display: "grid", gap: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
        <div>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>실제 받은 수량 <span style={{ color: C.hint, fontSize: 11 }}>· 보낸 {s.qty}장</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="number" value={recv} onChange={(e) => setRecv(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 110, boxSizing: "border-box", fontSize: 16, fontWeight: 600, padding: "9px 12px", border: `1px solid ${mismatch ? C.amber : C.border}`, borderRadius: 8, textAlign: "center" }} />
            {mismatch && <span style={{ fontSize: 12, color: C.amber, fontWeight: 600 }}>⚠ 수량상이 ({recv - s.qty > 0 ? "+" : ""}{recv - s.qty}) — 보낸 쪽에 확인 요청돼요</span>}
          </div>
        </div>
        <PhotoCapture photos={photos} setPhotos={setPhotos} label="입고 사진 (필수)" hint="받은 파렛트 / 차량" />
        <SignaturePad onSave={setSign} label="인수자 서명 (필수)" />
      </div>
    </div>
  );
}

function Recovery({ ships, ajReqs, partners, palletTypes, centers = CENTERS, recoverToCenter, recoverToAj }) {
  const [act, setAct] = useState(null); // { partner, pallet, max }
  // 보유 중인 거래처 × 유형 목록 (회수/반납 대상)
  const rows = [];
  partners.forEach((p) => palletTypes.forEach((t) => {
    const avail = availableToRecover(ships, ajReqs, p.code, t.code);
    if (avail > 0) rows.push({ partner: p, pallet: t.code, avail });
  }));
  const pendingAj = ajReqs.filter((r) => r.type === "회수" && r.partner_code && r.status === "요청");
  const totalAvail = rows.reduce((a, r) => a + r.avail, 0);

  return (
    <>
      <Head title="회수 관리" sub="거래처·시공팀 보유분을 센터로 반납하거나 AJ로 회수 요청" />
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Metric label="회수 대상 보유" value={totalAvail} unit="장" tone="plain" />
        <Metric label="보유 거래처" value={new Set(rows.map((r) => r.partner.code)).size} unit="곳" tone="info" />
        <Metric label="AJ 회수 진행중" value={pendingAj.reduce((a, r) => a + r.qty, 0)} unit="장" tone="warn" />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>거래처</Th><Th>구분</Th><Th>유형</Th><Th r>보유</Th><Th>회수 처리</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.partner.code + r.pallet} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td b>{r.partner.name}</Td><Td><TypeBadge t={r.partner.type} /></Td>
                <Td>{r.pallet}</Td><Td r b>{r.avail}</Td>
                <Td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setAct({ ...r, mode: "센터" })} style={btnTealSm}>센터 반납</button>
                    <button onClick={() => setAct({ ...r, mode: "AJ" })} style={{ ...btnTealSm, background: C.amber }}>AJ 회수</button>
                  </div>
                </Td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} style={{ padding: "20px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>회수할 보유 파렛트가 없어요.</td></tr>}
          </tbody>
        </table>
      </div>
      {pendingAj.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>AJ 회수 진행중 <span style={{ color: C.hint, fontWeight: 400, fontSize: 12 }}>· AJ 연동 메뉴에서 완료 처리</span></h3>
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}><thead><tr><Th>거래처</Th><Th>유형</Th><Th r>수량</Th><Th>요청일</Th></tr></thead>
              <tbody>{pendingAj.map((r) => <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}><Td>{r.partner_name}</Td><Td>{r.pallet_code}</Td><Td r>{r.qty}</Td><Td c={C.sub}>{fmtDT(r.requested_at)}</Td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      <Note>보유분을 <b>센터 반납</b>(우리 센터 재고로 +) 또는 <b>AJ 회수</b>(AJ로 보냄)로 처리해요. 시공팀처럼 경로가 갈리는 경우 건별로 선택하면 됩니다. AJ 회수는 AJ 연동 메뉴에서 완료 처리하면 재고에 반영돼요.</Note>
      {act && <RecoverModal act={act} centers={centers} onClose={() => setAct(null)} recoverToCenter={recoverToCenter} recoverToAj={recoverToAj} />}
    </>
  );
}

function RecoverModal({ act, centers = CENTERS, onClose, recoverToCenter, recoverToAj }) {
  const [qty, setQty] = useState(act.avail);
  const [center, setCenter] = useState(centers[0]);
  const [busy, setBusy] = useState(false);
  const isCenter = act.mode === "센터";
  const go = async () => {
    const q = Math.min(act.avail, Math.max(1, Number(qty) || 0));
    setBusy(true);
    if (isCenter) await recoverToCenter(act.partner, act.pallet, q, center);
    else await recoverToAj(act.partner, act.pallet, q);
    setBusy(false); onClose();
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: "100%", maxWidth: 360 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600 }}>{isCenter ? "센터로 반납" : "AJ로 회수"}</h3>
        <div style={{ fontSize: 12, color: C.hint, marginBottom: 16 }}>{act.partner.name} · {act.pallet} · 보유 {act.avail}장</div>
        {isCenter && (
          <>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>받는 센터</div>
            <select value={center} onChange={(e) => setCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 14 }}>{centers.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          </>
        )}
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>수량</div>
        <input type="number" value={qty} max={act.avail} onChange={(e) => setQty(Math.min(act.avail, Math.max(1, parseInt(e.target.value) || 1)))} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ ...btnGhost, padding: "10px 14px" }}>취소</button>
          <button onClick={go} disabled={busy} style={{ flex: 1, fontSize: 14, padding: "10px 14px", borderRadius: 8, border: "none", background: busy ? "#c7cad1" : (isCenter ? C.teal : C.amber), color: "#fff", cursor: "pointer" }}>{busy ? "처리 중…" : isCenter ? "센터 반납" : "AJ 회수요청"}</button>
        </div>
      </div>
    </div>
  );
}

// 재고 현황 — 장부 재고(센터별) + 분포(거래처 보유) + AJ 미처리
function Inventory({ ships, ajReqs, partners, palletTypes, centers = CENTERS }) {
  const centerTotal = (type) => centers.reduce((a, c) => a + centerStock(ships, ajReqs, c, type), 0);
  const partnerTotal = (type) => partners.reduce((a, p) => a + heldQty(ships, ajReqs, p.code, type), 0);
  const inTransit = (type) => sum(ships.filter((s) => !isReturn(s) && s.pallet_code === type && !s.canceled && s.status === "출고완료")); // 출고했으나 미확인
  const ajPending = (type) => sum(ajReqs.filter((r) => r.pallet_code === type && r.status === "요청"));
  const grand = (type) => centerTotal(type) + partnerTotal(type) + inTransit(type);
  const heldByPartner = partners.map((p) => ({ p, types: palletTypes.map((t) => heldQty(ships, ajReqs, p.code, t.code)), tot: palletTypes.reduce((a, t) => a + heldQty(ships, ajReqs, p.code, t.code), 0) })).filter((r) => r.tot > 0);

  return (
    <>
      <Head title="재고 현황" sub="장부 재고(센터) · 거래처 분포 · 이동중 — 어디에 몇 장 있는지" />
      {/* 센터별 재고 */}
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>센터 보유 재고 (장부)</h3>
      <div style={{ overflowX: "auto", marginBottom: 22 }}>
        <table style={tbl}>
          <thead><tr><Th>센터</Th>{palletTypes.map((t) => <Th key={t.code} r>{t.code}</Th>)}<Th r>합계</Th></tr></thead>
          <tbody>
            {centers.map((c) => { const tot = palletTypes.reduce((a, t) => a + centerStock(ships, ajReqs, c, t.code), 0); return (
              <tr key={c} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td b>{c}</Td>
                {palletTypes.map((t) => { const q = centerStock(ships, ajReqs, c, t.code); return <Td key={t.code} r c={q < 0 ? C.red : C.text}>{q.toLocaleString()}</Td>; })}
                <Td r b>{tot.toLocaleString()}</Td>
              </tr>
            ); })}
            <tr style={{ borderTop: `2px solid ${C.border}`, background: "#eef0f3" }}>
              <td style={{ padding: "11px 6px", fontSize: 12, fontWeight: 700 }}>센터 합계</td>
              {palletTypes.map((t) => <td key={t.code} style={{ padding: "11px 6px", fontSize: 12, fontWeight: 700, textAlign: "right" }}>{centerTotal(t.code).toLocaleString()}</td>)}
              <td style={{ padding: "11px 6px", fontSize: 12, fontWeight: 700, textAlign: "right" }}>{palletTypes.reduce((a, t) => a + centerTotal(t.code), 0).toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 전체 분포 요약 */}
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>전체 분포 <span style={{ color: C.hint, fontWeight: 400, fontSize: 12 }}>· 우리 센터 + 거래처 보유 + 이동중</span></h3>
      <div style={{ overflowX: "auto", marginBottom: 18 }}>
        <table style={tbl}>
          <thead><tr><Th>유형</Th><Th r>센터</Th><Th r>거래처 보유</Th><Th r>이동중</Th><Th r>AJ 미처리</Th><Th r>유통 총계</Th></tr></thead>
          <tbody>
            {palletTypes.map((t) => (
              <tr key={t.code} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td b>{t.code}</Td>
                <Td r>{centerTotal(t.code).toLocaleString()}</Td>
                <Td r>{partnerTotal(t.code).toLocaleString()}</Td>
                <Td r c={C.sub}>{inTransit(t.code).toLocaleString()}</Td>
                <Td r c={ajPending(t.code) ? C.amber : C.hint}>{ajPending(t.code).toLocaleString()}</Td>
                <Td r b>{grand(t.code).toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 거래처별 보유 */}
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>거래처 보유 분포 {heldByPartner.length > 0 && <span style={{ color: C.hint, fontWeight: 400, fontSize: 12 }}>· {heldByPartner.length}곳</span>}</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>거래처</Th><Th>구분</Th>{palletTypes.map((t) => <Th key={t.code} r>{t.code}</Th>)}<Th r>합계</Th></tr></thead>
          <tbody>
            {heldByPartner.map(({ p, types, tot }) => (
              <tr key={p.code} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td b>{p.name}</Td><Td><TypeBadge t={p.type} /></Td>
                {types.map((q, i) => <Td key={i} r c={q ? C.text : C.hint}>{q || "—"}</Td>)}
                <Td r b>{tot}</Td>
              </tr>
            ))}
            {heldByPartner.length === 0 && <tr><td colSpan={palletTypes.length + 3} style={{ padding: "16px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>거래처 보유 중인 파렛트가 없어요.</td></tr>}
          </tbody>
        </table>
      </div>
      <Note>장부 재고 = 오프닝({OPENING_QTY.toLocaleString()}장/종, {OPENING_CENTER}) + AJ공급 − 출고 + 반납입고 − AJ회수. 거래처 보유는 입고확인분 기준이에요. (실사 입력·차이 분석은 다음 단계로 추가 예정)</Note>
    </>
  );
}

// AJ 연동 — 공급/회수 요청 등록·완료 처리 (가설정: 수동 2단계)
function AjLink({ ajReqs, palletTypes, createAjRequest, completeAjRequest, confirmAjSupply, cancelAjRequest, ships, caps = {}, centers = CENTERS }) {
  const canCreate = !!caps.aj; // 내부만 요청 생성, AJ직원은 처리만
  const [type, setType] = useState("공급");
  const [qtys, setQtys] = useState({});
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const { idx: ediIdx } = useEdiIndex();
  const pinfo = usePalletInfo();
  const wpList = useMemo(() => (ediIdx ? ediIdx.wps.filter((w) => w.no > 0 && !w.closed).sort((a, b) => (a.kind === "센터" ? 0 : 1) - (b.kind === "센터" ? 0 : 1) || a.no - b.no) : []), [ediIdx]);
  const [wpNo, setWpNo] = useState(null);
  const wp = wpList.find((w) => w.no === wpNo) || null;
  const center = wp ? (wp.pms_center || ediClean(wp.name)) : null;
  const tomorrow = localD(new Date(Date.now() + 86400000).toISOString());
  const [want, setWant] = useState({ date: tomorrow, time: "", oper: "01", tons: "05", ctype: "00", phone: "" });
  const [toEdi, setToEdi] = useState(true);
  const setW = (k, v) => setWant((o) => ({ ...o, [k]: v }));
  // 제품 → EDI 계정, 받는 작업장 → 그 계정의 작업장 번호
  const ediLine = (code) => { if (!ediIdx || !wp) return null; const a = ediIdx.accOf(code); const local = a && ediIdx.local[a.code + "|" + wp.no]; return a && local ? { edi_account: a.code, edi_local: local, accName: ediIdx.accName(a.code) } : { miss: !a ? "EDI 계정 없음" : "이 작업장이 " + ediIdx.accName(a.code) + " 계정에 없음" }; };
  const total = qtysTotal(qtys);
  const pending = ajReqs.filter((r) => r.status === "요청");          // AJ직원 처리 대기
  const inbound = ajReqs.filter((r) => r.type === "공급" && r.status === "발송"); // 우리 센터 입고 대기
  const done = ajReqs.filter((r) => r.status === "완료").slice(0, 30);
  const isSupply = type === "공급";

  const submit = async () => {
    setBusy(true);
    if (!wp) { setBusy(false); alert("작업장을 고르세요."); return; }
    const useEdi = isSupply && toEdi;
    if (useEdi && want.date <= localD(new Date().toISOString())) { setBusy(false); alert("EDI 납품요청은 희망일이 내일 이후여야 해요."); return; }
    const lines = qtysToLines(qtys).map((l) => { const e = useEdi ? ediLine(l.pallet) : null; return e && e.edi_account ? { ...l, edi_account: e.edi_account, edi_local: e.edi_local } : l; });
    const ok = await createAjRequest({ type, lines, center, note, edi: isSupply ? { wp_no: wp.no, want_date: want.date, want_time: want.time, cars_oper: want.oper, cars_tons: want.oper === "03" ? null : want.tons, cars_type: want.ctype, phone: want.phone } : null });
    setBusy(false); if (ok) { setQtys({}); setNote(""); }
  };

  return (
    <>
      <Head title={canCreate ? "AJ 요청" : "AJ 요청 처리"} sub={canCreate ? "AJ네트웍스에 공급/회수 요청 · 완료 시 재고 반영 (가설정 수동)" : "접수된 요청을 처리(완료)하세요 · AJ네트웍스 직원용"} />
      <div style={{ display: "grid", gridTemplateColumns: canCreate ? "repeat(auto-fit, minmax(300px, 1fr))" : "1fr", gap: 16, alignItems: "start" }}>
        {/* 요청 등록 (내부만) */}
        {canCreate && <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>새 요청</h3>
          <div style={{ display: "flex", gap: 6, marginBottom: 16, background: "#eef0f3", borderRadius: 10, padding: 4 }}>
            {[["공급", "공급요청 (AJ→센터)"], ["회수", "회수요청 (센터→AJ)"]].map(([v, label]) => (
              <button key={v} onClick={() => setType(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: type === v ? (v === "공급" ? C.teal : C.amber) : "transparent", color: type === v ? "#fff" : C.sub }}>{label}</button>
            ))}
          </div>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isSupply ? "공급 받는 작업장" : "회수 보내는 작업장"} <span style={{ color: C.hint, fontSize: 11 }}>· EDI 작업장 전체 검색</span></div>
          <div style={{ marginBottom: 16 }}><WorkplacePicker wps={wpList} value={wpNo} onChange={setWpNo} width="100%" placeholder={ediIdx ? "센터·작업장 (이름·번호)" : "작업장 목록 불러오는 중…"} /></div>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형·수량 <span style={{ color: C.hint, fontSize: 11 }}>· 사진을 누르면 크게 보여요</span></div>
          <PalletQtyEditor palletTypes={palletTypes} qtys={qtys} setQtys={setQtys} color={isSupply ? C.teal : C.amber} bg={isSupply ? C.tealBg : C.amberBg} imgOf={(c) => pinfo[c] || null} />
          {isSupply && <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 14, background: "#fafbfc" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, marginBottom: toEdi ? 10 : 0 }}><input type="checkbox" checked={toEdi} onChange={(e) => setToEdi(e.target.checked)} /> EDI 납품요청으로 보내기</label>
            {toEdi && <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <label style={{ fontSize: 12, color: C.sub }}>희망일<input type="date" value={want.date} min={tomorrow} onChange={(e) => setW("date", e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }} /></label>
                <label style={{ fontSize: 12, color: C.sub }}>희망시간<select value={want.time} onChange={(e) => setW("time", e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }}><option value="">선택 안 함</option><option>오전</option><option>오후</option></select></label>
                <label style={{ fontSize: 12, color: C.sub }}>배차<select value={want.oper} onChange={(e) => setW("oper", e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }}><option value="01">AJ배차</option><option value="03">내방 (지점은 EDI에서 선택)</option></select></label>
                {want.oper !== "03" && <label style={{ fontSize: 12, color: C.sub }}>통행가능 최대톤수<select value={want.tons} onChange={(e) => setW("tons", e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }}><option value="01">1톤 이하</option><option value="02">2.5톤 이하</option><option value="03">3.5톤 이하</option><option value="04">5톤 이하</option><option value="05">11톤 이하</option><option value="06">톤수 상관없음</option></select></label>}
                <label style={{ fontSize: 12, color: C.sub }}>차량<select value={want.ctype} onChange={(e) => setW("ctype", e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }}><option value="00">상관없음</option><option value="01">윙바디</option><option value="02">카고</option></select></label>
                <label style={{ fontSize: 12, color: C.sub }}>현장 연락처<input value={want.phone} onChange={(e) => setW("phone", e.target.value)} placeholder="010-…" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, marginTop: 3 }} /></label>
              </div>
              {wp && qtysToLines(qtys).map((l) => { const e = ediLine(l.pallet); return <div key={l.pallet} style={{ fontSize: 11.5, color: e && e.edi_account ? C.sub : C.red }}>{l.pallet}: {e && e.edi_account ? e.accName + " 계정 · 작업장 " + e.edi_local : (e ? e.miss : "") + " → EDI로 안 보내져요"}</div>; })}
              <div style={{ fontSize: 11, color: C.hint, marginTop: 6, lineHeight: 1.5 }}>접수하면 EDI 납품요청/조회 화면 오른쪽 위 LETUS 상자에 떠요 → [채우기] → [등록]. 마감시간 이후 익일 요청·휴일은 EDI가 막아요.</div>
            </>}
          </div>}
          {total > 0 && <div style={{ fontSize: 12, color: C.sub, marginBottom: 12, textAlign: "right" }}>합계 <b style={{ color: C.text }}>{total}</b>장</div>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모(선택)" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 14, resize: "vertical", fontFamily: "inherit" }} />
          <button disabled={total === 0 || busy} onClick={submit} style={{ width: "100%", background: (total === 0 || busy) ? "#c7cad1" : (isSupply ? C.teal : C.amber), color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 15, cursor: "pointer" }}>{busy ? "접수 중…" : !wp ? "작업장을 고르세요" : `${type}요청 접수`}</button>
        </div>}

        {/* AJ 처리 대기 (요청) */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>AJ 처리 대기 <span style={{ color: C.hint, fontWeight: 400 }}>{pending.length}</span></h3>
          {pending.length === 0 ? <div style={{ fontSize: 13, color: C.hint, padding: "12px 0" }}>대기 중인 요청이 없어요.</div> : (
            <div style={{ display: "grid", gap: 8 }}>
              {pending.map((r) => (
                <div key={r.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 11, color: "#fff", background: r.type === "공급" ? C.teal : C.amber, padding: "1px 7px", borderRadius: 10 }}>{r.type}</span>
                      <span style={{ fontSize: 13, marginLeft: 6 }}>{r.pallet_code} · {r.qty}장</span>
                      <div style={{ fontSize: 11, color: C.hint, marginTop: 2 }}>{r.partner_name || r.center} · {fmtDT(r.requested_at)}{r.want_date ? " · 희망 " + r.want_date.slice(5) + (r.want_time ? " " + r.want_time : "") : ""}</div>
                      {r.edi_status && <div style={{ fontSize: 11, marginTop: 2, color: r.edi_status === "등록" ? C.green : C.blue }}>EDI 납품요청: {r.edi_status === "등록" ? "등록됨" : "대기 (EDI 납품요청 화면에서 채우기 → 등록)"}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => completeAjRequest(r)} style={btnTealSm}>{r.type === "공급" ? "발송" : "회수완료"}</button>
                      {canCreate && <button onClick={() => cancelAjRequest(r)} style={{ ...btnGhost, padding: "5px 8px" }}>✕</button>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* 우리 센터 입고 대기 (공급 발송분) */}
          {inbound.length > 0 && (
            <>
              <h3 style={{ margin: "16px 0 10px", fontSize: 14, fontWeight: 600 }}>센터 입고 대기 <span style={{ color: C.hint, fontWeight: 400 }}>{inbound.length}</span> <span style={{ color: C.hint, fontWeight: 400, fontSize: 11 }}>· 입고확인 메뉴에서도 처리 가능</span></h3>
              <div style={{ display: "grid", gap: 8 }}>
                {inbound.map((r) => (
                  <div key={r.id} style={{ border: `1px solid ${C.teal}`, background: C.tealBg, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 11, color: "#fff", background: C.teal, padding: "1px 7px", borderRadius: 10 }}>공급·발송됨</span>
                        <span style={{ fontSize: 13, marginLeft: 6 }}>{r.pallet_code} · {r.qty}장</span>
                        <div style={{ fontSize: 11, color: C.hint, marginTop: 2 }}>{r.center} · 발송 {fmtDT(r.sent_at)}</div>
                      </div>
                      {canCreate && <button onClick={() => confirmAjSupply(r)} style={btnTeal}>✓ 센터 입고확인</button>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {done.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>처리 완료 <span style={{ color: C.hint, fontWeight: 400, fontSize: 12 }}>· 최근 {done.length}</span></h3>
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}><thead><tr><Th>구분</Th><Th>유형</Th><Th r>수량</Th><Th>대상</Th><Th>완료일시</Th></tr></thead>
              <tbody>{done.map((r) => <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}><Td>{r.type}</Td><Td>{r.pallet_code}</Td><Td r>{r.qty}</Td><Td>{r.partner_name || r.center}</Td><Td c={C.sub}>{fmtDT(r.completed_at)}</Td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      <Note>공급요청 완료 → 센터 재고 +. 회수요청 완료 → 센터/거래처 재고 −, AJ로. 지금은 수동 2단계(가설정)예요 — 나중에 실제 AJ EDI 연동으로 이 완료 처리가 자동화됩니다.</Note>
    </>
  );
}

// ─── EDI 재고·정산 (AJ EDI 일별 재고 기반) ─────────────────────
// 정산: 전월 26일 ~ 당월 25일 · 월 사용장수 = 일별 보유수량 합 ÷ 일수(올림) × 단가
const AJ_UNIT_DEFAULT = 2400;
const isoD = (d) => d.toISOString().slice(0, 10);
// 기간 선택 + [조회]: 날짜를 바꾸는 동안은 다시 불러오지 않고 [조회]를 눌러야 반영. 시작이 끝보다 늦어지면 끝(또는 시작)이 따라온다
function DateRange({ from, to, onApply, children }) {
  const [f, setF] = useState(from); const [t, setT] = useState(to);
  useEffect(() => { setF(from); setT(to); }, [from, to]);
  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };
  const dirty = f !== from || t !== to;
  return (
    <>
      <input type="date" value={f} onChange={(e) => { const v = e.target.value; setF(v); if (v && t && v > t) setT(v); }} style={inp} />
      <span style={{ color: C.hint }}>~</span>
      <input type="date" value={t} onChange={(e) => { const v = e.target.value; setT(v); if (v && f && v < f) setF(v); }} onKeyDown={(e) => { if (e.key === "Enter") onApply(f, t); }} style={inp} />
      <button onClick={() => onApply(f, t)} style={{ ...btnTealSm, background: dirty ? C.teal : C.tealDk }}>조회</button>
      {children}
    </>
  );
}
const periodOf = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  const s = new Date(Date.UTC(y, m - 2, 26)), e = new Date(Date.UTC(y, m - 1, 25));
  return { from: isoD(s), to: isoD(e), days: Math.round((e - s) / 86400000) + 1 };
};
const billingMonthOf = (d) => { const x = new Date(d.getTime() + 9 * 3600000); const y = x.getUTCFullYear(), m = x.getUTCMonth(), dd = x.getUTCDate(); const t = new Date(Date.UTC(y, dd >= 26 ? m + 1 : m, 1)); return isoD(t).slice(0, 7); };

// ─── 작업장 검색 선택창: 입력하면 바로 후보가 뜨고, 클릭/엔터로 선택 ───────────
function WorkplacePicker({ wps, value, onChange, filter, placeholder = "작업장 검색 (이름·번호)", width = 280 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const cur = wps.find((w) => w.no === value);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return wps.filter((w) => (!filter || filter(w)) && (!t || (w.no + " " + w.name + " " + (w.kind || "")).toLowerCase().includes(t))).slice(0, 60);
  }, [wps, q, filter]);
  const pick = (w) => { onChange(w.no); setOpen(false); setQ(""); };
  const label = (w) => `${w.no}. ${w.closed ? "(폐쇄) " : ""}${w.name}`;
  return (
    <div style={{ position: "relative", width }}>
      <input
        value={open ? q : cur ? label(cur) : ""}
        placeholder={placeholder}
        onFocus={(e) => { setOpen(true); setQ(""); setHi(0); e.target.select(); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && list[hi]) { e.preventDefault(); pick(list[hi]); e.target.blur(); }
          else if (e.key === "Escape") { setOpen(false); e.target.blur(); }
        }}
        style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }}
      />
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, maxHeight: 300, overflowY: "auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 6px 18px rgba(0,0,0,.12)", zIndex: 50 }}>
          {list.length === 0 && <div style={{ padding: 10, fontSize: 12, color: C.sub }}>검색 결과가 없어요</div>}
          {list.map((w, i) => (
            <div key={w.no} onMouseDown={(e) => { e.preventDefault(); pick(w); }} onMouseEnter={() => setHi(i)}
              style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", background: i === hi ? "#eef6f4" : "transparent", display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{label(w)}</span><span style={{ color: C.hint, fontSize: 11 }}>{w.kind}{w.last_synced ? "" : " · 미수집"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ediRecentMonths = (nowMonth) => { const out = []; let [y, m] = nowMonth.split("-").map(Number); for (let i = 0; i < 9; i++) { out.push(`${y}-${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } } return out; };

// ─── 월 마감·정산서 ─────────────────────────────────────────────────────────
function EdiBilling({ caps = {} }) {
  const nowMonth = billingMonthOf(new Date());
  const [month, setMonth] = useState(nowMonth);
  const [unit, setUnit] = useState(AJ_UNIT_DEFAULT);
  const [neg, setNeg] = useState("zero");
  const [basis, setBasis] = useState("this");
  const [kindF, setKindF] = useState("bill"); // bill=청구 대상(시공팀·업체) / center / all
  const [q, setQ] = useState("");
  const [calc, setCalc] = useState([]);
  const [closed, setClosed] = useState(null);
  const [lines, setLines] = useState([]);
  const [maxDate, setMaxDate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const per = useMemo(() => periodOf(month), [month]);
  const complete = maxDate && maxDate >= per.to;
  const [cover, setCover] = useState(null); // 계정별 수집된 날짜(전체 합계 0번 행 기준)
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: accs }, { data: rows }] = await Promise.all([
        supabase.from("aj_account").select("code,label,name"),
        supabase.from("aj_stock_daily").select("account,stoc_date").eq("workplace_no", 0).gte("stoc_date", per.from).lte("stoc_date", per.to).neq("item", "-").limit(5000),
      ]);
      if (!alive) return;
      const days = []; for (let d = new Date(per.from + "T00:00:00"); localD(d.toISOString()) <= per.to; d.setDate(d.getDate() + 1)) days.push(localD(d.toISOString()));
      const today = localD(new Date().toISOString());
      const due = days.filter((d) => d < today); // 어제까지가 받을 수 있는 날
      const have = {}; (rows || []).forEach((r) => { (have[r.account] = have[r.account] || new Set()).add(r.stoc_date); });
      setCover((accs || []).map((a) => { const h = have[a.code] || new Set(); const missing = due.filter((d) => !h.has(d)); return { code: a.code, label: a.label || a.name || a.code, got: h.size, due: due.length, total: days.length, missing }; }));
    })();
    return () => { alive = false; };
  }, [per.from, per.to, tick]);
  const coverOk = cover && cover.every((c) => c.missing.length === 0 && c.due === c.total);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setMsg("");
      const [h, md] = await Promise.all([
        supabase.from("aj_billing_close").select("*").eq("month", month).maybeSingle(),
        supabase.from("aj_stock_daily").select("stoc_date").neq("item", "-").order("stoc_date", { ascending: false }).limit(1),
      ]);
      if (!alive) return;
      if (h.error) { setMsg("정산 테이블을 못 불러왔어요. letus_edi4.sql 실행 여부를 확인해주세요. (" + h.error.message + ")"); setBusy(false); return; }
      setClosed(h.data || null);
      setMaxDate(md.data && md.data[0] ? md.data[0].stoc_date : null);
      const useUnit = h.data ? h.data.unit : unit, useNeg = h.data ? h.data.neg_mode : neg, useBasis = h.data ? h.data.basis : basis;
      if (h.data) { setUnit(useUnit); setNeg(useNeg); setBasis(useBasis); }
      const c = await supabase.rpc("aj_billing_calc", { p_from: per.from, p_to: per.to, p_neg: useNeg, p_basis: useBasis, p_default_unit: useUnit });
      if (!alive) return;
      if (c.error) { setMsg("정산 계산에 실패했어요: " + c.error.message); setBusy(false); return; }
      setCalc(c.data || []);
      if (h.data) {
        const all = [];
        for (let p = 0; p < 20; p++) {
          const { data } = await supabase.from("aj_billing_line").select("*").eq("month", month).order("workplace_no").range(p * 1000, p * 1000 + 999);
          all.push(...(data || [])); if (!data || data.length < 1000) break;
        }
        if (alive) setLines(all);
      } else setLines([]);
      if (alive) setBusy(false);
    })();
    return () => { alive = false; };
  }, [month, per.from, per.to, tick, neg, basis]); // eslint-disable-line

  const isBill = (k) => k === "시공팀" || k === "업체";
  // 마감된 달은 저장된 스냅샷을, 아니면 현재 계산값을 보여준다
  const base = closed ? lines.map((l) => ({ workplace_no: l.workplace_no, workplace_name: l.workplace_name, kind: l.kind, item: l.item, sum_qty: l.sum_qty, avg_qty: l.avg_qty, unit: l.unit, unit_mode: "fixed", amount: l.amount })) : calc.map((c) => ({ ...c, amount: c.avg_qty * (c.unit ?? unit) }));
  const shown = base.filter((r) => (kindF === "all" || (kindF === "bill" ? isBill(r.kind) : r.kind === "센터")) && (!q || (r.workplace_name + " " + r.item).includes(q)));
  const totBill = base.filter((r) => isBill(r.kind)).reduce((a, r) => a + Number(r.amount), 0);
  const qtyBill = base.filter((r) => isBill(r.kind)).reduce((a, r) => a + Number(r.avg_qty), 0);
  const wpsBill = new Set(base.filter((r) => isBill(r.kind)).map((r) => r.workplace_no)).size;
  const curTot = calc.filter((c) => isBill(c.kind)).reduce((a, c) => a + c.avg_qty * (c.unit ?? (closed ? closed.unit : unit)), 0);
  const drift = closed ? curTot - Number(closed.total_amount || 0) : 0;

  const doClose = async () => {
    if (cover && !coverOk && !window.confirm("수집이 끝나지 않았어요:\n" + cover.map((c) => `${c.label}: ${c.got}/${c.total}일${c.missing.length ? " (빠진 날 " + c.missing.map((d) => d.slice(5)).join(", ") + ")" : ""}`).join("\n") + "\n\n그래도 마감할까요?")) return;
    if (!window.confirm(`${month} 정산(${per.from} ~ ${per.to})을 마감 확정할까요?\n청구 대상 ${wpsBill}곳, ${won(totBill)}\n확정 후 변동분은 다음 달에 반영돼요.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("aj_billing_close_month", { p_month: month, p_unit: unit, p_neg: neg, p_basis: basis, p_note: note || null });
    if (error) { setMsg(error.message); setBusy(false); return; }
    setTick((t) => t + 1);
  };
  const doReopen = async () => {
    if (!window.confirm(`${month} 마감을 취소(재오픈)할까요? 저장된 정산 내역이 삭제돼요.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("aj_billing_reopen", { p_month: month });
    if (error) { setMsg(error.message); setBusy(false); return; }
    setTick((t) => t + 1);
  };
  const exportXlsx = () => {
    const u = closed ? closed.unit : unit;
    const detail = base.filter((r) => kindF === "all" || (kindF === "bill" ? isBill(r.kind) : r.kind === "센터"))
      .map((r) => ({ 작업장: r.workplace_name, 구분: r.kind, 제품: r.item, "일별 보유합계(장·일)": Number(r.sum_qty), "사용 장수": Number(r.avg_qty), "단가(원)": r.unit ?? u, "금액(원)": Number(r.amount) }));
    const byWp = {};
    detail.forEach((r) => { const k = r.작업장; byWp[k] = byWp[k] || { 작업장: k, 구분: r.구분, "사용 장수": 0, "금액(원)": 0 }; byWp[k]["사용 장수"] += r["사용 장수"]; byWp[k]["금액(원)"] += r["금액(원)"]; });
    const sum = Object.values(byWp).sort((a, b) => b["금액(원)"] - a["금액(원)"]);
    sum.push({ 작업장: "합계", 구분: "", "사용 장수": sum.reduce((a, r) => a + r["사용 장수"], 0), "금액(원)": sum.reduce((a, r) => a + r["금액(원)"], 0) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), "업체별 합계");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "제품별 상세");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ 정산월: month, 기간: `${per.from} ~ ${per.to}`, 일수: per.days, 단가: u, 마이너스: neg === "zero" ? "0장 처리" : "그대로", 재고기준: { this: "금일재고 전체", cont: "계약재고", back: "회수재고", conf: "확인재고" }[basis], 상태: closed ? `마감 확정 ${fmtDT(closed.closed_at)}` : "진행중(잠정)" }]), "기준");
    XLSX.writeFile(wb, `LETUS_EDI정산_${month}${closed ? "" : "_잠정"}.xlsx`);
  };
  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };
  const locked = !!closed;

  return (
    <>
      <Head title="임대료 정산 (우리 → 브랜드 청구)" sub={`정산 기간 ${per.from} ~ ${per.to} (${per.days}일) · 일별 보유합계 ÷ ${per.days}일(올림) × 단가`} action={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={exportXlsx} disabled={!shown.length} style={{ ...btnGhost, padding: "8px 14px", opacity: shown.length ? 1 : 0.5 }}>⬇ 정산서 엑셀</button>
          {caps.billing && !closed && <button onClick={doClose} disabled={busy || !complete || !calc.length} title={complete ? "" : "재고 데이터가 마감일까지 들어와야 해요"} style={{ ...btnGreen, opacity: busy || !complete || !calc.length ? 0.5 : 1 }}>마감 확정</button>}
          {caps.users && closed && <button onClick={doReopen} disabled={busy} style={{ ...btnGhost, padding: "8px 14px", color: C.red }}>마감 취소(재오픈)</button>}
        </div>} />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: C.sub }}>정산월</span>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={inp}>{ediRecentMonths(nowMonth).map((m) => <option key={m} value={m}>{m}</option>)}</select>
        <span style={{ fontSize: 13, color: C.sub }} title="규격별 임대료가 없는 제품에만 적용돼요">기본 단가</span>
        <input type="number" value={unit} disabled={locked} onChange={(e) => setUnit(Number(e.target.value) || 0)} style={{ ...inp, width: 90 }} />
        <select value={neg} disabled={locked} onChange={(e) => setNeg(e.target.value)} style={inp}><option value="zero">마이너스 0장 처리</option><option value="raw">마이너스 그대로</option></select>
        <select value={basis} disabled={locked} onChange={(e) => setBasis(e.target.value)} style={inp}><option value="this">금일재고 전체</option><option value="cont">계약재고</option><option value="back">회수재고</option><option value="conf">확인재고</option></select>
        <select value={kindF} onChange={(e) => setKindF(e.target.value)} style={inp}><option value="bill">청구 대상(시공팀·업체)</option><option value="center">센터(참고)</option><option value="all">전체</option></select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="작업장·제품 검색" style={{ ...inp, width: 160 }} />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Metric label="상태" value={closed ? "마감 확정" : complete ? "마감 가능" : "진행중(잠정)"} tone={closed ? "success" : complete ? "info" : "warn"} />
        <Metric label="청구 대상" value={wpsBill.toLocaleString()} unit="곳" tone="plain" />
        <Metric label="사용 장수" value={qtyBill.toLocaleString()} unit="장" tone="plain" />
        <Metric label="청구 금액" value={won(totBill)} tone="info" />
        {closed && <Metric label="마감 후 변동(다음 달 반영)" value={(drift > 0 ? "+" : "") + won(drift)} tone={drift ? "warn" : "success"} />}
      </div>
      {cover && !closed && <div style={{ background: coverOk ? C.greenBg : C.amberBg, color: coverOk ? C.green : C.amber, padding: "9px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 10, lineHeight: 1.7 }}>
        <b>마감 전 수집 점검</b> ({per.from.slice(5)} ~ {per.to.slice(5)}, {cover[0] ? cover[0].total : 0}일){coverOk ? " · 3개 계정 모두 완료, 마감 가능" : ""}
        {cover.map((c) => <div key={c.code}>{c.missing.length ? "⚠" : "✓"} {c.label}: {c.got}/{c.total}일 수집{c.missing.length ? " · 빠진 날 " + c.missing.map((d) => d.slice(5)).join(", ") + " → 그 계정으로 EDI 로그인해 동기화" : c.due < c.total ? " · 남은 날은 매일 동기화로 채워져요" : ""}</div>)}
      </div>}
      {!complete && !closed && <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>재고 데이터가 {maxDate || "—"}까지 들어와 있어요. {per.to}까지 들어오면 마감할 수 있어요. 지금 금액은 진행 중인 잠정값(전체 {per.days}일로 나눔)이에요.</div>}
      {closed && <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>{fmtDT(closed.closed_at)} {closed.closed_by || ""} 확정{closed.note ? ` · ${closed.note}` : ""}</div>}
      {caps.billing && !closed && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="마감 메모(선택)" style={{ ...inp, width: 280, marginBottom: 12 }} />}
      {busy ? <Splash text="불러오는 중…" /> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tbl}>
            <thead><tr><Th>작업장</Th><Th>구분</Th><Th>제품</Th><Th r>보유합계(장·일)</Th><Th r>사용 장수</Th><Th r>단가</Th><Th r>금액</Th></tr></thead>
            <tbody>
              {shown.slice(0, 400).map((r, i) => (
                <tr key={r.workplace_no + r.item + i} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{r.workplace_name}</Td><Td>{r.kind}</Td><Td>{r.item}</Td><Td r>{Number(r.sum_qty).toLocaleString()}</Td><Td r>{Number(r.avg_qty).toLocaleString()}</Td><Td r>{r.unit == null ? "" : Number(r.unit).toLocaleString()}{r.unit_mode === "actual" ? " (실비 추정)" : r.unit_mode === "default" ? " (기본)" : ""}</Td><Td r b>{Number(r.amount).toLocaleString()}</Td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} style={{ padding: 16, fontSize: 13, color: C.sub }}>표시할 내역이 없어요.</td></tr>}
            </tbody>
          </table>
          {shown.length > 400 && <div style={{ fontSize: 12, color: C.sub, padding: 8 }}>상위 400줄만 표시해요(엑셀에는 전체가 들어가요). 검색으로 좁혀 보세요.</div>}
        </div>
      )}
    </>
  );
}

// ─── 대사·이상 징후: EDI 재고 vs PMS 센터 장부, 마이너스·불일치 점검 ───────────────
function EdiRecon({ caps = {}, ships = [], ajReqs = [], centers = [], palletTypes = [] }) {
  const [wps, setWps] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true);
      const w = await supabase.from("aj_workplace").select("*").order("no").limit(1000);
      const md = await supabase.from("aj_stock_daily").select("stoc_date").neq("item", "-").order("stoc_date", { ascending: false }).limit(1);
      if (!alive) return;
      if (w.error) { setMsg(w.error.message); setBusy(false); return; }
      const d = md.data && md.data[0] ? md.data[0].stoc_date : null;
      let r = [];
      if (d) { const s = await supabase.from("aj_stock_daily").select("workplace_no,item,this_stoc").eq("stoc_date", d).neq("item", "-").limit(3000); r = mergeByWorkplace(s.data || []); }
      const ac = await supabase.from("aj_account").select("*").order("first_seen");
      const accs = [];
      for (const a of ac.data || []) {
        const mx = await supabase.from("aj_stock_daily").select("stoc_date").eq("account", a.code).neq("item", "-").order("stoc_date", { ascending: false }).limit(1);
        accs.push({ ...a, max_date: mx.data && mx.data[0] ? mx.data[0].stoc_date : null });
      }
      if (!alive) return;
      setAccounts(accs); setWps(w.data || []); setDate(d); setRows(r); setBusy(false);
    })();
    return () => { alive = false; };
  }, [tick]);

  const byNo = useMemo(() => Object.fromEntries(wps.map((w) => [w.no, w])), [wps]);
  const mapped = (c) => wps.find((w) => w.pms_center === c) || wps.find((w) => w.name === c && !w.closed);
  const saveMap = async (center, no) => {
    const a = await supabase.from("aj_workplace").update({ pms_center: null }).eq("pms_center", center);
    const b = await supabase.from("aj_workplace").update({ pms_center: center }).eq("no", no);
    if (a.error || b.error) setMsg((a.error || b.error).message); else setTick((t) => t + 1);
  };
  const ediOf = (no, item) => { const r = rows.find((x) => x.workplace_no === no && x.item === item); return r ? r.this_stoc : null; };
  const codes = palletTypes.map((p) => p.code);
  const ediItems = [...new Set(rows.map((r) => r.item))].sort();
  const overlap = ediItems.filter((i) => codes.includes(i));

  // 이상 징후
  const items = ediItems;
  const sumBy = (fn) => Object.fromEntries(items.map((i) => [i, rows.filter((r) => r.item === i && fn(r)).reduce((a, r) => a + r.this_stoc, 0)]));
  const total0 = sumBy((r) => r.workplace_no === 0), sumWp = sumBy((r) => r.workplace_no !== 0);
  const negs = rows.filter((r) => r.workplace_no !== 0 && r.this_stoc < 0).sort((a, b) => a.this_stoc - b.this_stoc);
  const negByKind = {};
  negs.forEach((r) => { const k = (byNo[r.workplace_no] || {}).kind || "?"; negByKind[k] = (negByKind[k] || 0) + r.this_stoc; });

  return (
    <>
      <Head title="대사·이상 징후" sub={`EDI 재고(${date || "—"} 기준)와 PMS 장부를 맞춰 보고, 전산-실물 차이가 큰 곳을 찾아요`} />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      {busy ? <Splash text="불러오는 중…" /> : (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>0. EDI 계정별 수집 현황</div>
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={tbl}>
              <thead><tr><Th>구분</Th><Th>EDI 계정</Th><Th>제품</Th><Th>최근 접속</Th><Th>최신 재고일</Th></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.code} style={{ borderTop: `1px solid ${C.border}` }}>
                    <Td b>{caps.users ? <input defaultValue={a.label || ""} placeholder="예: 일반유형(11A·15A)" onBlur={async (e) => { if (e.target.value !== (a.label || "")) { await supabase.from("aj_account").update({ label: e.target.value || null }).eq("code", a.code); setTick((t) => t + 1); } }} style={{ fontSize: 13, padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 6, width: 150 }} /> : (a.label || "—")}</Td>
                    <Td>{a.name || a.code}<div style={{ fontSize: 11, color: C.hint }}>{a.code}</div></Td>
                    <Td>{(a.items || []).join(", ") || "—"}</Td>
                    <Td>{a.last_seen ? fmtDT(a.last_seen) : "—"}</Td>
                    <Td>{a.max_date || "아직 없음"}</Td>
                  </tr>
                ))}
                {!accounts.length && <tr><td colSpan={5} style={{ padding: 14, fontSize: 13, color: C.sub }}>letus_edi6.sql 실행 후 EDI에 로그인하면 계정이 자동 등록돼요.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: C.sub, margin: "-12px 0 20px" }}>계정마다 EDI 로그인이 따로예요. 3개 계정(14C·18F / 일반유형 11A·15A / 23E)이 모두 최근에 접속·수집돼야 재고가 완전해요.</div>

          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>1. PMS 센터 ↔ EDI 작업장 맵핑과 재고 비교</div>
          {!overlap.length && <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, lineHeight: 1.6 }}>PMS 파렛트 유형 코드({codes.join(", ") || "없음"})와 EDI 제품({ediItems.join(", ") || "없음"})이 겹치지 않아 재고 수치를 직접 비교할 수 없어요. 맵핑만 먼저 해 두면, 유형 코드를 맞춘 뒤 바로 비교돼요.</div>}
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={tbl}>
              <thead><tr><Th>PMS 센터</Th><Th>연결된 EDI 작업장</Th>{overlap.map((i) => <Th key={i} r>{i} PMS / EDI / 차이</Th>)}</tr></thead>
              <tbody>
                {centers.map((c) => {
                  const w = mapped(c);
                  return (
                    <tr key={c} style={{ borderTop: `1px solid ${C.border}` }}>
                      <Td b>{c}</Td>
                      <Td>{caps.users ? <WorkplacePicker wps={wps} value={w ? w.no : null} filter={(x) => !x.closed} onChange={(no) => saveMap(c, no)} width={240} placeholder="EDI 작업장 선택" /> : (w ? w.name : "—")}</Td>
                      {overlap.map((i) => {
                        const pms = centerStock(ships, ajReqs, c, i), edi = w ? ediOf(w.no, i) : null, diff = edi === null ? null : pms - edi;
                        return <Td key={i} r>{pms.toLocaleString()} / {edi === null ? "—" : edi.toLocaleString()} / <span style={{ color: diff ? C.red : C.green, fontWeight: 600 }}>{diff === null ? "—" : diff.toLocaleString()}</span></Td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>2. 전체 합계 vs 작업장별 합 (EDI 내부 일치 여부)</div>
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={tbl}>
              <thead><tr><Th>제품</Th><Th r>전체 합계(모든작업장)</Th><Th r>작업장별 합</Th><Th r>차이</Th></tr></thead>
              <tbody>{items.map((i) => { const d = sumWp[i] - total0[i]; return (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}><Td b>{i}</Td><Td r>{total0[i].toLocaleString()}</Td><Td r>{sumWp[i].toLocaleString()}</Td><Td r b><span style={{ color: d ? C.red : C.green }}>{d.toLocaleString()}</span></Td></tr>); })}</tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: C.sub, margin: "-12px 0 20px" }}>차이가 있으면 폐쇄 작업장(동기화 제외)에 남은 재고이거나 수집 누락일 수 있어요.</div>

          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>3. 마이너스 재고 작업장 — 전산-실물을 맞출 대상 ({negs.length}곳·제품, {date})</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>구분별 마이너스 합: {Object.entries(negByKind).map(([k, v]) => `${k} ${v.toLocaleString()}장`).join(" · ") || "없음"}</div>
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}>
              <thead><tr><Th>작업장</Th><Th>구분</Th><Th>제품</Th><Th r>금일재고</Th></tr></thead>
              <tbody>{negs.slice(0, 60).map((r, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}><Td>{(byNo[r.workplace_no] || {}).name || r.workplace_no}</Td><Td>{(byNo[r.workplace_no] || {}).kind}</Td><Td>{r.item}</Td><Td r b><span style={{ color: C.red }}>{r.this_stoc.toLocaleString()}</span></Td></tr>
              ))}{!negs.length && <tr><td colSpan={4} style={{ padding: 14, fontSize: 13, color: C.sub }}>마이너스 재고가 없어요.</td></tr>}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ─── 임차료 정산(AJ가 우리에게 청구) — 관리자 전용: 명세서 vs EDI 구내용 추정, 임대료와 비교 ───────────
function EdiCost({ caps = {} }) {
  const nowMonth = billingMonthOf(new Date());
  const [month, setMonth] = useState(nowMonth);
  const [inv, setInv] = useState([]);
  const [lines, setLines] = useState([]);
  const [rates, setRates] = useState({});
  const [stock, setStock] = useState([]);
  const [calc, setCalc] = useState([]);
  const [busy, setBusy] = useState(true);
  const [msg, setMsg] = useState("");
  const per = useMemo(() => periodOf(month), [month]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setMsg("");
      const [iv, r, st, c] = await Promise.all([
        supabase.from("aj_invoice").select("*").eq("month", month).order("account"),
        supabase.from("aj_cost_rate").select("*"),
        supabase.from("aj_stock_daily").select("account,item,stoc_date,this_stoc").eq("workplace_no", 0).neq("item", "-").gte("stoc_date", per.from).lte("stoc_date", per.to).limit(5000),
        supabase.rpc("aj_billing_calc", { p_from: per.from, p_to: per.to, p_neg: "zero", p_basis: "this", p_default_unit: AJ_UNIT_DEFAULT }),
      ]);
      if (!alive) return;
      const er = iv.error || r.error || st.error || c.error;
      if (er) { setMsg("불러오지 못했어요: " + er.message); setBusy(false); return; }
      const ids = (iv.data || []).map((x) => x.id);
      const ln = ids.length ? await supabase.from("aj_invoice_line").select("*").in("invoice_id", ids).order("id") : { data: [] };
      if (!alive) return;
      setInv(iv.data || []); setLines(ln.data || []); setRates(Object.fromEntries((r.data || []).map((x) => [x.code, x])));
      setStock(st.data || []); setCalc(c.data || []); setBusy(false);
    })();
    return () => { alive = false; };
  }, [month, per.from, per.to]);

  // 규격 묶음: 명세서는 14C·18F를 한 줄(14C+18F)로 청구한다
  const groupOf = (item) => (item === "14C" || item === "18F" ? "14C+18F" : item);
  const days = new Set(stock.map((s) => s.stoc_date)).size;
  const scale = days ? per.days / days : 0; // 진행 중이면 월환산
  const ediBy = {};
  stock.forEach((s) => {
    const g = groupOf(s.item), rt = Number((rates[s.item] || {}).daily_rate) || 0;
    ediBy[g] = ediBy[g] || { jangil: 0, amount: 0 };
    ediBy[g].jangil += s.this_stoc; ediBy[g].amount += s.this_stoc * rt;
  });
  const invBy = {};
  lines.filter((l) => l.kind === "구내용").forEach((l) => {
    const g = l.item.split("+").sort().join("+") === "14C+18F" ? "14C+18F" : l.item;
    invBy[g] = invBy[g] || { jangil: 0, amount: 0 };
    invBy[g].jangil += Number(l.qty); invBy[g].amount += Number(l.amount);
  });
  const groups = [...new Set([...Object.keys(ediBy), ...Object.keys(invBy)])].filter((g) => (ediBy[g] && ediBy[g].jangil) || invBy[g]).sort();

  const invSupply = inv.reduce((a, x) => a + Number(x.supply || 0), 0);
  const ediGu = Object.values(ediBy).reduce((a, x) => a + x.amount, 0) * scale;
  const cost = inv.length ? invSupply : ediGu; // 명세서가 있으면 명세서, 없으면 EDI 구내용 추정(월환산)
  const isBill = (k) => k === "시공팀" || k === "업체";
  const rent = calc.filter((c) => isBill(c.kind)).reduce((a, c) => a + c.avg_qty * c.unit, 0);
  const centerCost = calc.filter((c) => c.kind === "센터").reduce((a, c) => a + c.avg_qty * (Number((rates[c.item] || {}).daily_rate) || 0) * per.days, 0);
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };

  if (!caps.users) return <div style={{ color: C.sub, fontSize: 13 }}>임차료 정산은 관리자만 볼 수 있어요.</div>;
  return (
    <>
      <Head title="임차료 정산 (AJ → 우리)" sub={`정산월 ${month} · 사용기간 ${per.from} ~ ${per.to} (${per.days}일) · AJ 명세서와 EDI 데이터 대조, 임대료와 비교`} />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: C.sub }}>정산월</span>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={inp}>{ediRecentMonths(nowMonth).map((m) => <option key={m} value={m}>{m}</option>)}</select>
        <span style={{ fontSize: 12, color: C.hint }}>EDI 수집 {days}/{per.days}일{days && days < per.days ? " · 진행 중이라 월환산" : ""}</span>
      </div>
      {busy ? <Splash text="불러오는 중…" /> : (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <Metric label={inv.length ? "임차료 (명세서 공급가)" : "임차료 (EDI 구내용 추정)"} value={won(Math.round(cost))} tone="plain" />
            <Metric label="임대료 (청구 대상 시공팀·업체)" value={won(Math.round(rent))} tone="info" />
            <Metric label="임대료 − 임차료" value={won(Math.round(rent - cost))} tone={rent - cost < 0 ? "danger" : "success"} />
            <Metric label="센터 보유분 구내용 (추정)" value={won(Math.round(centerCost))} tone="warn" />
          </div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, marginBottom: 12 }}>
            임대료는 "임대료 정산" 탭과 같은 규칙(일별 보유합 ÷ 일수 올림 × 규격별 단가, 마이너스 0 처리)으로 계산해요. 센터 보유분은 청구되지 않지만 AJ 구내용은 나가는 물량이에요.
            {!inv.length && " 이 달은 아직 AJ 명세서가 없어서 임차료를 EDI 구내용(운송비·수송용 제외)으로 추정했어요."}
          </div>

          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>구내용 대조 (명세서 vs EDI 전체합계 장·일)</div>
          <div style={{ overflowX: "auto", marginBottom: 18 }}>
            <table style={tbl}>
              <thead><tr><Th>규격</Th><Th r>명세서 장·일</Th><Th r>EDI 장·일</Th><Th r>차이</Th><Th r>명세서 구내용</Th><Th r>EDI 추정{days && days < per.days ? "(월환산)" : ""}</Th></tr></thead>
              <tbody>
                {groups.map((g) => {
                  const a = invBy[g], e = ediBy[g] || { jangil: 0, amount: 0 }, d = a ? pct(e.jangil, a.jangil) : null;
                  return (
                    <tr key={g} style={{ borderTop: `1px solid ${C.border}` }}>
                      <Td b>{g}</Td><Td r>{a ? a.jangil.toLocaleString() : "—"}</Td><Td r>{e.jangil.toLocaleString()}</Td>
                      <Td r>{d === null ? "—" : <span style={{ color: Math.abs(d) < 2 ? C.green : C.red, fontWeight: 600 }}>{d.toFixed(1)}%</span>}</Td>
                      <Td r>{a ? a.amount.toLocaleString() : "—"}</Td><Td r>{Math.round(e.amount * scale).toLocaleString()}</Td>
                    </tr>
                  );
                })}
                {!groups.length && <tr><td colSpan={6} style={{ padding: 14, fontSize: 13, color: C.sub }}>이 달의 데이터가 없어요.</td></tr>}
              </tbody>
            </table>
          </div>
          {days && days < per.days && inv.length ? <div style={{ fontSize: 12, color: C.red, margin: "-10px 0 16px" }}>EDI 수집 기간({days}일)이 명세서 기간({per.days}일)보다 짧아 장·일 차이는 참고만 하세요.</div> : null}

          <div style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 8px" }}>AJ 명세서 {inv.length ? `(${inv.length}건)` : ""}</div>
          {!inv.length && <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>등록된 명세서가 없어요. 명세서는 "파렛트·단가 → AJ 임차료 명세서"에 쌓여요.</div>}
          {inv.map((iv) => (
            <div key={iv.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6, fontSize: 13 }}>
                <b>{iv.account}{iv.note ? ` · ${iv.note}` : ""}</b>
                <span>공급가 {won(iv.supply)} + 부가세 {won(iv.vat)} = <b>{won(iv.total)}</b></span>
              </div>
              <table style={tbl}>
                <thead><tr><Th>제품</Th><Th>구분</Th><Th r>수량</Th><Th r>단가</Th><Th r>금액</Th></tr></thead>
                <tbody>{lines.filter((l) => l.invoice_id === iv.id).map((l) => (
                  <tr key={l.id} style={{ borderTop: `1px solid ${C.border}` }}><Td>{l.item}</Td><Td>{l.kind}</Td><Td r>{Number(l.qty).toLocaleString()}</Td><Td r>{l.unit_price == null ? "" : Number(l.unit_price).toLocaleString()}</Td><Td r b>{Number(l.amount).toLocaleString()}</Td></tr>
                ))}</tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function EdiStock({ caps = {}, ships = [], ajReqs = [], centers = [], palletTypes = [] }) {
  const [view, setView] = useState("stock");
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["stock", "재고 흐름"], ["bill", "임대료 정산(청구)"], ...(caps.users ? [["cost", "임차료 정산(AJ)"]] : []), ["move", "이동 현황 (어디서 → 어디로)"], ["export", "EDI 반영(업로드)"], ["recon", "대사·이상 징후"]].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...btnGhost, padding: "7px 16px", background: view === k ? C.teal : "transparent", color: view === k ? "#04342C" : C.text, fontWeight: view === k ? 600 : 400 }}>{l}</button>
        ))}
      </div>
      {view === "stock" ? <EdiStockView caps={caps} /> : view === "bill" ? <EdiBilling caps={caps} /> : view === "cost" ? <EdiCost caps={caps} /> : view === "move" ? <EdiMoves /> : view === "export" ? <EdiExport ships={ships} /> : <EdiRecon {...{ caps, ships, ajReqs, centers, palletTypes }} />}
    </>
  );
}

// PMS 출고·반납·이동 → EDI 반영: 이동등록 창 [업로드]용 엑셀을 계정·출고처별로 만들고, EDI 이동 동기화 후 이동코드와 연결
// 엑셀 형식(AJ 양식): 이동일자(YYYYMMDD) · 제품 · 수량 · 입고처코드 · 입고처순번 · 차량정보 · 인수증번호 · 비고. 출고처는 EDI 화면에서 고른다
const ediClean = (n) => String(n || "").replace(/^\((폐쇄|차단_폐쇄)\)|^\[차단_폐쇄\]/, "").trim();
const localD = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const EDI_LABEL = { 엑셀생성: "EDI 대기" };
const EDI_ST = { 미반영: [C.amber, C.amberBg], 엑셀생성: [C.blue, C.blueBg], 반영: [C.green, C.greenBg], 제외: [C.sub, "#f1f2f4"] };
// EDI 작업장 기준 정보(작업장·계정별 번호·계정·입고처 목록)를 읽어 PMS 센터·거래처와 짝지을 색인을 만든다 (EDI 반영·재고현황 공용)
function useEdiIndex() {
  const [ref, setRef] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      const page = async (q) => { const all = []; for (let p = 0; p < 20; p++) { const { data, error } = await q().range(p * 1000, p * 1000 + 999); if (error) throw error; all.push(...(data || [])); if (!data || data.length < 1000) break; } return all; };
      try {
        const [wps, maps, accs, dests] = await Promise.all([
          page(() => supabase.from("aj_workplace").select("no,name,kind,pms_center,partner_code,closed").order("no")),
          page(() => supabase.from("aj_workplace_map").select("account,local_no,wp_no").order("account").order("local_no")),
          supabase.from("aj_account").select("code,name,label,items").then((r) => { if (r.error) throw r.error; return r.data || []; }),
          page(() => supabase.from("aj_dest").select("account,demd_code,demd_numb,post_name,usag_flag,blok_list,self_code").order("account").order("demd_code").order("demd_numb")),
        ]);
        if (alive) setRef({ wps, maps, accs, dests });
      } catch (e) { if (alive) setErr("기준 정보를 불러오지 못했어요. letus_edi8.sql 실행 여부를 확인해주세요. (" + (e.message || e) + ")"); }
    })();
    return () => { alive = false; };
  }, []);
  const idx = useMemo(() => {
    if (!ref) return null;
    const wpByCenter = {}, wpByPartner = {};
    ref.wps.forEach((w) => { if (w.partner_code) wpByPartner[w.partner_code] = w; });
    ref.wps.forEach((w) => { const k = w.pms_center || ediClean(w.name); const cur = wpByCenter[k]; if (!cur || (!cur.pms_center && (w.pms_center || (cur.closed && !w.closed)))) wpByCenter[k] = w; });
    const local = {}; ref.maps.forEach((m) => { if (m.local_no) local[m.account + "|" + m.wp_no] = m.local_no; });
    const dest = {}, destByName = {};
    ref.dests.forEach((d) => { dest[d.account + "|" + d.demd_code + "|" + d.demd_numb] = d; const k = d.account + "|" + ediClean(d.post_name); (destByName[k] = destByName[k] || []).push(d); });
    const accOf = (item) => ref.accs.filter((a) => (a.items || []).includes(item)).sort((a, b) => /전용/.test(a.label || a.name || "") - /전용/.test(b.label || b.name || ""))[0];
    const wpByNo = {}; ref.wps.forEach((w) => { wpByNo[w.no] = w; });
    return { wps: ref.wps, wpByNo, wpByCenter, wpByPartner, local, dest, destByName, accOf, accName: (c) => { const a = ref.accs.find((x) => x.code === c); return (a && (a.label || a.name)) || c; } };
  }, [ref]);

  return { idx, err };
}
// PMS 전표 1건의 EDI 출고처·입고처 작업장 (반납은 거래처 → 센터)
function ediRoute(idx, s) {
  if (s.from_wp && s.to_wp) { const f = idx.wpByNo[s.from_wp], t = idx.wpByNo[s.to_wp]; return { fromWp: f, toWp: t, fromLabel: s.from_name || (f && f.name), toLabel: s.to_partner_name || (t && t.name) }; }
  const centerWp = idx.wpByCenter[s.center];
  const partnerWp = s.to_partner ? idx.wpByPartner[s.to_partner] : null;
  const toCenterWp = s.to_center ? idx.wpByCenter[s.to_center] : null;
  if (s.direction === "반납") return { fromWp: partnerWp, toWp: centerWp, fromLabel: s.to_partner_name, toLabel: s.center };
  if (s.direction === "이동") return { fromWp: centerWp, toWp: toCenterWp, fromLabel: s.center, toLabel: s.to_center || s.to_partner_name };
  return { fromWp: centerWp, toWp: partnerWp, fromLabel: s.center, toLabel: s.to_partner_name };
}
// 작업장 이름 → 표준 작업장 (EDI 이동 내역은 이름으로만 온다)
const wpByNameOf = (idx) => { const m = {}; idx.wps.forEach((w) => { const k = ediClean(w.name); if (!m[k] || (m[k].closed && !w.closed)) m[k] = w; }); return m; };
// PMS 미반영 건: EDI 당일 이동 비고에 전표번호가 있으면(이미 EDI에 들어감) 빼고 계산
const pendingShips = (ships, todayMoves) => {
  const inEdi = new Set(); (todayMoves || []).forEach((m) => { const t = /PMS\s+(\S+)/.exec(m.note || ""); if (t) inEdi.add(t[1]); });
  return ships.filter((s) => !s.canceled && s.edi_status !== "반영" && s.edi_status !== "제외" && !inEdi.has(String(s.slip_no)));
};
// EDI 최신 기준일보다 뒤의 EDI 이동(동기화 때 오늘 것까지 받음)
async function loadMovesAfter(dates) {
  const out = [];
  for (const [acc, d] of Object.entries(dates)) {
    const { data } = await supabase.from("aj_move").select("account,move_date,item,from_name,to_name,qty,note").eq("account", acc).gt("move_date", d).limit(5000);
    out.push(...(data || []));
  }
  return out;
}
function useWpStock(wp, ships, idx) {
  const [st, setSt] = useState(null);
  const no = wp ? wp.no : null;
  useEffect(() => {
    if (!no || !idx) { setSt(null); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase.from("aj_stock_daily").select("account,item,this_stoc,stoc_date").eq("workplace_no", no).neq("item", "-").order("stoc_date", { ascending: false }).limit(60);
      const last = {}, items = {};
      (data || []).forEach((r) => { last[r.account] = last[r.account] || r.stoc_date; if (r.stoc_date === last[r.account]) items[r.item] = (items[r.item] || 0) + r.this_stoc; });
      const moves = await loadMovesAfter(last);
      const name = ediClean(wp.name);
      moves.forEach((m) => { if (ediClean(m.from_name) === name) items[m.item] = (items[m.item] || 0) - m.qty; if (ediClean(m.to_name) === name) items[m.item] = (items[m.item] || 0) + m.qty; });
      if (alive) setSt({ base: items, moves, date: Object.values(last).sort().pop() });
    })();
    return () => { alive = false; };
  }, [no, idx]);
  return useMemo(() => {
    if (!st) return null;
    const items = { ...st.base };
    pendingShips(ships, st.moves).forEach((s) => {
      const { fromWp, toWp } = ediRoute(idx, s);
      if (fromWp && fromWp.no === no) items[s.pallet_code] = (items[s.pallet_code] || 0) - s.qty;
      if (toWp && toWp.no === no) items[s.pallet_code] = (items[s.pallet_code] || 0) + s.qty;
    });
    return { items, date: st.date };
  }, [st, ships, idx, no]);
}

// 재고 현황(EDI 기준): 작업장 × 제품 현재고 = EDI 최신 기준일 재고 + PMS에 등록됐지만 EDI에 아직 안 들어간 건(예정 ±)
const ITEM_ORDER = ["14C", "18F", "11A", "15A", "23E", "12A"];
function EdiInventory({ ships = [] }) {
  const { idx, err } = useEdiIndex();
  const [stock, setStock] = useState(null); // { dates: {account: date}, rows: [{account, workplace_no, item, this_stoc}] }
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [only, setOnly] = useState("held"); // held=보유 있는 곳 / neg=마이너스 / all

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: accs, error: e0 } = await supabase.from("aj_account").select("code");
        if (e0) throw e0;
        const dates = {}, rows = [];
        for (const a of accs || []) {
          const { data: d } = await supabase.from("aj_stock_daily").select("stoc_date").eq("account", a.code).eq("workplace_no", 0).order("stoc_date", { ascending: false }).limit(1);
          if (!d || !d.length) continue;
          dates[a.code] = d[0].stoc_date;
          for (let p = 0; p < 20; p++) {
            const { data, error } = await supabase.from("aj_stock_daily").select("account,workplace_no,item,this_stoc")
              .eq("account", a.code).eq("stoc_date", d[0].stoc_date).neq("item", "-").order("workplace_no").order("item").range(p * 1000, p * 1000 + 999);
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
          }
        }
        const today = await loadMovesAfter(dates);
        if (alive) setStock({ dates, rows, today });
      } catch (e) { if (alive) setMsg("EDI 재고를 불러오지 못했어요. (" + (e.message || e) + ")"); }
    })();
    return () => { alive = false; };
  }, []);

  const data = useMemo(() => {
    if (!idx || !stock) return null;
    const wpByNo = {}; idx.wps.forEach((w) => { wpByNo[w.no] = w; });
    const items = ITEM_ORDER.filter((it) => stock.rows.some((r) => r.item === it));
    stock.rows.forEach((r) => { if (!items.includes(r.item)) items.push(r.item); });
    const total = {}; // EDI 전체 합계(0번)
    const m = {}; // wp no → { wp, edi: {item}, pend: {item} }
    const at = (no) => (m[no] = m[no] || { wp: wpByNo[no] || { no, name: "작업장 " + no, kind: "업체" }, edi: {}, pend: {} });
    stock.rows.forEach((r) => {
      if (r.workplace_no === 0) { total[r.item] = (total[r.item] || 0) + r.this_stoc; return; }
      const x = at(r.workplace_no); x.edi[r.item] = (x.edi[r.item] || 0) + r.this_stoc;
    });
    // EDI 기준일 이후(오늘) EDI에 들어간 이동: 출발 −, 도착 + (EDI 숫자에 합침)
    const byName = wpByNameOf(idx); let todayN = 0;
    (stock.today || []).forEach((mv) => {
      const f = byName[ediClean(mv.from_name)], t = byName[ediClean(mv.to_name)];
      if (!items.includes(mv.item)) items.push(mv.item);
      if (f) { const x = at(f.no); x.edi[mv.item] = (x.edi[mv.item] || 0) - mv.qty; }
      if (t) { const x = at(t.no); x.edi[mv.item] = (x.edi[mv.item] || 0) + mv.qty; }
      todayN++;
    });
    // PMS 미반영(EDI에 아직 없는) 건: 출고처 −, 입고처 +
    let pendN = 0; const unmapped = [];
    pendingShips(ships, stock.today).forEach((s) => {
      const { fromWp, toWp, fromLabel, toLabel } = ediRoute(idx, s);
      if (!fromWp || !toWp) { unmapped.push(s.slip_no + " " + (fromLabel || "—") + "→" + (toLabel || "—")); return; }
      pendN++;
      const it = s.pallet_code; if (!items.includes(it)) items.push(it);
      const f = at(fromWp.no), t = at(toWp.no);
      f.pend[it] = (f.pend[it] || 0) - s.qty; t.pend[it] = (t.pend[it] || 0) + s.qty;
    });
    const list = Object.values(m).map((x) => {
      const now = {}; let tot = 0, neg = false, any = false;
      items.forEach((it) => { const v = (x.edi[it] || 0) + (x.pend[it] || 0); now[it] = v; tot += v; if (v < 0) neg = true; if (v || x.edi[it] || x.pend[it]) any = true; });
      return { ...x, now, tot, neg, any };
    });
    const byKind = (k, it) => list.filter((x) => (x.wp.kind || "업체") === k).reduce((a, x) => a + (x.edi[it] || 0), 0);
    return { items, total, list, byKind, pendN, unmapped, todayN };
  }, [idx, stock, ships]);

  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };
  const err2 = err || msg;
  if (err2) return (<><Head title="재고 현황" sub="EDI 기준" /><div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13 }}>{err2}</div></>);
  if (!data) return (<><Head title="재고 현황" sub="EDI 기준" /><Splash text="불러오는 중…" /></>);

  const { items, total, list, byKind, pendN, unmapped, todayN } = data;
  const view = list.filter((x) => (!kind || (x.wp.kind || "업체") === kind) && (!q || (x.wp.name + " " + x.wp.no).includes(q)) && (only === "all" ? true : only === "neg" ? x.neg : x.any))
    .sort((a, b) => b.tot - a.tot || a.wp.name.localeCompare(b.wp.name));
  const dateTxt = [...new Set(Object.values(stock.dates))].sort().map((d) => d.slice(5)).join(", ");
  const negCnt = list.filter((x) => x.neg).length;

  return (
    <>
      <Head title="재고 현황" sub={`EDI 기준일 ${dateTxt} 재고 + 그 뒤 EDI 이동 ${todayN}건 + PMS 미반영 ${pendN}건(예정)`} />
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <table style={tbl}>
          <thead><tr><Th>제품</Th><Th r>EDI 전체</Th><Th r>센터</Th><Th r>시공팀</Th><Th r>업체</Th><Th r>PMS 예정(순)</Th></tr></thead>
          <tbody>{items.map((it) => {
            const pend = list.reduce((a, x) => a + (x.pend[it] || 0), 0);
            return (
              <tr key={it} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td b>{it}</Td><Td r b>{(total[it] || 0).toLocaleString()}</Td>
                <Td r>{byKind("센터", it).toLocaleString()}</Td><Td r>{byKind("시공팀", it).toLocaleString()}</Td><Td r>{byKind("업체", it).toLocaleString()}</Td>
                <Td r c={pend ? C.blue : C.hint}>{pend ? (pend > 0 ? "+" : "") + pend.toLocaleString() : "—"}</Td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {unmapped.length > 0 && <div style={{ background: C.amberBg, color: C.amber, padding: "8px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>EDI 작업장과 연결 안 된 PMS 건 {unmapped.length}건은 예정에서 빠졌어요: {unmapped.slice(0, 5).join(" · ")}{unmapped.length > 5 ? " …" : ""}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="작업장 검색 (이름·번호)" style={{ ...inp, width: 200 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inp}><option value="">전체 구분</option><option>센터</option><option>시공팀</option><option>업체</option></select>
        <select value={only} onChange={(e) => setOnly(e.target.value)} style={inp}><option value="held">재고·예정 있는 곳</option><option value="neg">마이너스만 ({negCnt})</option><option value="all">전체 작업장</option></select>
        <span style={{ fontSize: 12, color: C.hint }}>{view.length.toLocaleString()}곳 · 파란 숫자 = PMS 미반영(예정)</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>작업장</Th><Th>구분</Th>{items.map((it) => <Th key={it} r>{it}</Th>)}<Th r>합계</Th></tr></thead>
          <tbody>{view.slice(0, 400).map((x) => (
            <tr key={x.wp.no} style={{ borderTop: `1px solid ${C.border}` }}>
              <Td b>{x.wp.name} <span style={{ color: C.hint, fontSize: 11, fontWeight: 400 }}>{x.wp.no}</span></Td>
              <Td><TypeBadge t={x.wp.kind || "업체"} /></Td>
              {items.map((it) => {
                const v = x.now[it], p = x.pend[it] || 0;
                return <Td key={it} r c={v < 0 ? C.red : v ? C.text : C.hint}>{v ? v.toLocaleString() : "—"}{p ? <div style={{ fontSize: 11, color: C.blue }}>{p > 0 ? "+" : ""}{p}</div> : null}</Td>;
              })}
              <Td r b c={x.tot < 0 ? C.red : C.text}>{x.tot.toLocaleString()}</Td>
            </tr>
          ))}</tbody>
        </table>
        {view.length > 400 && <div style={{ fontSize: 12, color: C.hint, padding: 10 }}>상위 400곳만 표시 — 검색으로 좁혀 보세요.</div>}
      </div>
      <Note>EDI 재고(전일 마감)에 동기화 때 받은 오늘 EDI 이동을 더한 값이 검은 숫자예요(EDI에 직접 입력한 건 포함, 마지막 동기화 시점까지). PMS에 등록했지만 EDI에 아직 저장되지 않은 건은 예정(파란 숫자)으로 더해요. "EDI 전체"는 전일 마감 합계예요.</Note>
    </>
  );
}
function InventoryScreen(props) { return <EdiInventory ships={props.ships} />; }

function EdiExport({ ships = [] }) {
  const [from, setFrom] = useState(localD(new Date(Date.now() - 6 * 86400000).toISOString()));
  const [to, setTo] = useState(localD(new Date().toISOString()));
  const [stF, setStF] = useState("open");
  const [wpF, setWpF] = useState(""); // 출고처(EDI 추가 창에서 고르는 작업장)별로 보기
  const { idx, err: refErr } = useEdiIndex();
  const [moves, setMoves] = useState([]);
  const [over, setOver] = useState({}); // 화면에서 바꾼 상태 (새로고침 전까지)
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const all = [];
      for (let p = 0; p < 20; p++) {
        const { data, error } = await supabase.from("aj_move").select("account,move_code,move_date,item,from_name,to_name,qty,note")
          .gte("move_date", from).lte("move_date", isoD(new Date(new Date(to).getTime() + 3 * 86400000))).order("move_date").order("move_code").range(p * 1000, p * 1000 + 999);
        if (error) break;
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      if (alive) setMoves(all);
    })();
    return () => { alive = false; };
  }, [from, to]);

  const rows = useMemo(() => {
    if (!idx) return [];
    const out = ships.filter((s) => !s.canceled && s.depart_at && localD(s.depart_at) >= from && localD(s.depart_at) <= to).map((s) => {
      const o = over[s.id] || {};
      const status = (o.status !== undefined ? o.status : s.edi_status) || "미반영";
      const moveCode = o.move_code !== undefined ? o.move_code : s.edi_move_code;
      const date = localD(s.depart_at);
      const { fromWp, toWp, fromLabel, toLabel } = ediRoute(idx, s);
      const acc = idx.accOf(s.pallet_code);
      const issues = [];
      let fromLocal = null, ordeCode = null, ordeNumb = null;
      if (!acc) issues.push(`${s.pallet_code}을 쓰는 EDI 계정이 없어요`);
      if (!fromWp) issues.push(`출고처 '${fromLabel || "—"}'가 EDI 작업장과 연결돼 있지 않아요`);
      if (!toWp) issues.push(`입고처 '${toLabel || "—"}'가 EDI 작업장과 연결돼 있지 않아요`);
      if (acc && fromWp) { fromLocal = idx.local[acc.code + "|" + fromWp.no]; if (!fromLocal) issues.push(`출고처 '${fromWp.name}'가 ${idx.accName(acc.code)} 계정에 없어요`); }
      if (acc && toWp) {
        const own = idx.local[acc.code + "|" + toWp.no];
        if (own) { ordeCode = acc.code; ordeNumb = own; }
        else {
          const c = (idx.destByName[acc.code + "|" + ediClean(toWp.name)] || []).filter((d) => d.usag_flag === "Y");
          if (c.length === 1) { ordeCode = c[0].demd_code; ordeNumb = c[0].demd_numb; }
          else issues.push(`입고처 '${toWp.name}'의 EDI 코드를 찾지 못했어요${c.length > 1 ? " (같은 이름 " + c.length + "곳)" : ""}`);
        }
        const d = ordeCode && idx.dest[acc.code + "|" + ordeCode + "|" + ordeNumb];
        if (d && d.usag_flag !== "Y") issues.push(`EDI에서 입고처 '${d.post_name}'가 사용금지예요`);
        else if (d && String(d.blok_list || "").includes("3")) issues.push(`EDI에서 입고처 '${d.post_name}'가 이동입고 차단이에요`);
      }
      if (fromWp && toWp && fromWp.no === toWp.no) issues.push("출고처와 입고처가 같아요");
      // EDI 이동과 맞춰보기: 비고의 PMS 전표번호가 가장 확실, 없으면 같은 날·제품·수량·출발·도착이 하나뿐일 때
      let match = null;
      if (acc && status !== "반영" && status !== "제외") {
        const cand = moves.filter((m) => m.account === acc.code && m.item === s.pallet_code);
        match = (s.slip_no && cand.find((m) => (m.note || "").includes(String(s.slip_no)))) || null;
        if (!match && fromWp && toWp) {
          const f = cand.filter((m) => m.move_date === date && m.qty === s.qty && ediClean(m.from_name) === ediClean(fromWp.name) && ediClean(m.to_name) === ediClean(toWp.name));
          if (f.length === 1) match = { ...f[0], fuzzy: true };
        }
      }
      return { s, status, moveCode, date, acc, fromWp, toWp, fromLabel, toLabel, fromLocal, ordeCode, ordeNumb, issues, match };
    }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.s.slip_no).localeCompare(String(b.s.slip_no))));
    // 같은 EDI 이동코드가 두 PMS 건에 붙지 않게
    const used = new Set(out.filter((r) => r.status === "반영" && r.moveCode).map((r) => r.moveCode));
    const seen = {}; out.forEach((r) => { if (r.match) seen[r.match.move_code] = (seen[r.match.move_code] || 0) + 1; });
    out.forEach((r) => { if (r.match && (used.has(r.match.move_code) || seen[r.match.move_code] > 1)) r.match = null; });
    return out;
  }, [ships, idx, from, to, over, moves]);

  const fromKey = (r) => (r.fromWp ? String(r.fromWp.no) : "?" + (r.fromLabel || ""));
  const fromOpts = useMemo(() => {
    const m = {};
    rows.forEach((r) => { const k = fromKey(r); m[k] = m[k] || { k, name: r.fromWp ? r.fromWp.name : (r.fromLabel || "—") + " (EDI 미연결)", open: 0, all: 0 }; m[k].all++; if (r.status === "미반영" || r.status === "엑셀생성") m[k].open++; });
    return Object.values(m).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  }, [rows]);
  const inWp = (r) => !wpF || fromKey(r) === wpF;
  const view = rows.filter((r) => inWp(r) && (stF === "all" || (stF === "open" ? r.status === "미반영" || r.status === "엑셀생성" : r.status === stF)));
  const ready = rows.filter((r) => inWp(r) && r.status === "미반영" && !r.issues.length && !r.match);
  const groups = useMemo(() => {
    const m = {};
    ready.forEach((r) => { const k = r.acc.code + "|" + r.fromLocal; (m[k] = m[k] || { acc: r.acc, fromWp: r.fromWp, fromLocal: r.fromLocal, rows: [] }).rows.push(r); });
    return Object.values(m).sort((a, b) => a.acc.code.localeCompare(b.acc.code) || a.fromWp.name.localeCompare(b.fromWp.name));
  }, [ready]);
  const cnt = (st) => rows.filter((r) => inWp(r) && r.status === st).length;
  const bad = rows.filter((r) => inWp(r) && r.status === "미반영" && r.issues.length).length;
  const matchable = rows.filter((r) => inWp(r) && r.match && (r.status === "미반영" || r.status === "엑셀생성"));

  const mark = async (list, status, moveCode = null) => {
    const { error } = await supabase.rpc("edi_mark", { p_ids: list.map((r) => String(r.s.id)), p_status: status, p_move_code: moveCode });
    if (error) { alert("상태 저장 실패: " + error.message); return false; }
    setOver((o) => { const n = { ...o }; list.forEach((r) => { n[r.s.id] = { status, move_code: moveCode }; }); return n; });
    return true;
  };
  const download = async (g) => {
    const data = g.rows.map((r) => ({ 이동일자: r.date.replace(/-/g, ""), 제품: r.s.pallet_code, 수량: String(r.s.qty), 입고처코드: r.ordeCode, 입고처순번: r.ordeNumb, 차량정보: r.s.vehicle_no || "", 인수증번호: "", 비고: "PMS " + r.s.slip_no }));
    const ws = XLSX.utils.json_to_sheet(data, { header: ["이동일자", "제품", "수량", "입고처코드", "입고처순번", "차량정보", "인수증번호", "비고"] });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const safe = (t) => String(t).replace(/[\\/:*?"<>|]/g, "_");
    XLSX.writeFile(wb, `EDI업로드_${safe(idx.accName(g.acc.code))}_${safe(g.fromWp.name)}_${from.replace(/-/g, "")}-${to.replace(/-/g, "")}.xlsx`);
    await mark(g.rows, "엑셀생성");
  };
  // EDI 이동등록 창의 스크립트(v3.5)가 읽어 가는 대기열로 보내기 (엑셀 없이 자동으로 표를 채움)
  const sendQueue = async (gs) => {
    const list = gs.flatMap((g) => g.rows);
    if (!list.length) return;
    setBusy(true);
    const payload = list.map((r) => ({ ship_id: String(r.s.id), slip_no: r.s.slip_no, account: r.acc.code, from_local: r.fromLocal, from_name: r.fromWp.name, move_date: r.date.replace(/-/g, ""), item: r.s.pallet_code, qty: r.s.qty, orde_code: r.ordeCode, orde_numb: r.ordeNumb, to_name: r.toWp ? r.toWp.name : null, cars_info: r.s.vehicle_no || "", note: "PMS " + r.s.slip_no }));
    const { error } = await supabase.rpc("edi_queue", { p_rows: payload });
    setBusy(false);
    if (error) { alert("자동입력 보내기 실패: " + error.message + (/edi_queue/.test(error.message) ? " (letus_edi9.sql 실행 필요)" : "")); return; }
    setOver((o) => { const n = { ...o }; list.forEach((r) => { n[r.s.id] = { status: "엑셀생성", move_code: null }; }); return n; });
    setMsg(`${list.length}건을 EDI 자동입력으로 보냈어요. EDI 이동조회/관리 → [추가] 창 오른쪽 위 LETUS 상자에서 출고처별 [채우기] → [저장].`);
  };
  const downloadAll = async () => { setBusy(true); for (const g of groups) { await download(g); await new Promise((r) => setTimeout(r, 400)); } setBusy(false); };
  const linkAll = async () => {
    setBusy(true); let n = 0;
    for (const r of matchable) { if (await mark([r], "반영", r.match.move_code)) n++; }
    setBusy(false); setMsg(`${n}건을 EDI 이동과 연결했어요.`);
  };
  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };
  const Pill = ({ st }) => { const [c, bg] = EDI_ST[st] || EDI_ST.미반영; return <span style={{ fontSize: 11, color: c, background: bg, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>{EDI_LABEL[st] || st}</span>; };
  const sm = { ...btnGhost, padding: "3px 8px" };

  return (
    <>
      <Head title="EDI 반영" sub="PMS 출고·반납·이동을 EDI 이동등록 [업로드]용 엑셀로 만들고, 동기화 후 EDI 이동코드와 자동 연결" />
      <div style={{ background: C.blueBg, color: C.blue, padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.7, marginBottom: 12 }}>
        <b>자동입력(추천)</b>: ① <b>EDI 자동입력 보내기</b> → ② EDI에 그 계정으로 로그인 → 이동조회/관리 → <b>추가</b> → 창 오른쪽 위 LETUS 상자에서 출고처별 <b>[채우기]</b> → 노란 줄(그 출고처에서 못 보내는 곳·사용금지) 확인 → <b>저장</b>. 저장하면 여기 바로 "반영"으로 바뀌어요.<br /><b>엑셀</b>: 파일을 받아 추가 창에서 출고처 선택 → <b>업로드</b> → 저장 → 다음 동기화 뒤 <b>자동 연결</b>.
      </div>
      {refErr && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{refErr}</div>}
      {msg && <div style={{ background: /못|실패/.test(msg) ? C.redBg : C.greenBg, color: /못|실패/.test(msg) ? C.red : C.green, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <DateRange from={from} to={to} onApply={(f, t) => { setFrom(f); setTo(t); }} />
        <select value={stF} onChange={(e) => setStF(e.target.value)} style={inp}>
          <option value="open">처리 필요 (미반영·EDI 대기)</option><option value="미반영">미반영</option><option value="엑셀생성">EDI 대기</option><option value="반영">반영</option><option value="제외">제외</option><option value="all">전체</option>
        </select>
        <select value={wpF} onChange={(e) => setWpF(e.target.value)} style={{ ...inp, maxWidth: 260 }} title="EDI 추가 창에서 고르는 출고처 작업장">
          <option value="">전체 출고처</option>
          {fromOpts.map((o) => <option key={o.k} value={o.k}>{o.name} · 처리필요 {o.open}/{o.all}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Metric label="미반영" value={cnt("미반영")} unit="건" tone={cnt("미반영") ? "warn" : "success"} />
        <Metric label="EDI 대기(보냄·엑셀, 저장 전)" value={cnt("엑셀생성")} unit="건" tone="info" />
        <Metric label="반영" value={cnt("반영")} unit="건" tone="success" />
        <Metric label="연결 오류(확인 필요)" value={bad} unit="건" tone={bad ? "warn" : "plain"} />
      </div>

      {!idx ? (refErr ? null : <Splash text="불러오는 중…" />) : (
        <>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>업로드 엑셀 ({groups.length}개 파일 · {ready.length}건)</div>
              {groups.length > 0 && <button disabled={busy} onClick={() => sendQueue(groups)} style={btnTealSm}>EDI 자동입력 보내기 ({ready.length}건)</button>}
              {groups.length > 1 && <button disabled={busy} onClick={downloadAll} style={btnGhost}>엑셀 전체 받기</button>}
              {matchable.length > 0 && <button disabled={busy} onClick={linkAll} style={{ ...btnTealSm, background: C.green }}>EDI 이동과 자동 연결 ({matchable.length}건)</button>}
            </div>
            {!groups.length ? <div style={{ fontSize: 13, color: C.sub }}>엑셀로 만들 미반영 건이 없어요.</div> : (
              <table style={tbl}>
                <thead><tr><Th>EDI 계정</Th><Th>출고처 (EDI 화면에서 선택)</Th><Th r>건수</Th><Th r>수량</Th><Th></Th></tr></thead>
                <tbody>{groups.map((g) => (
                  <tr key={g.acc.code + g.fromLocal} style={{ borderTop: `1px solid ${C.border}` }}>
                    <Td>{idx.accName(g.acc.code)} <span style={{ color: C.hint, fontSize: 11 }}>{g.acc.code}</span></Td>
                    <Td b>{g.fromWp.name} <span style={{ color: C.hint, fontSize: 11, fontWeight: 400 }}>작업장 {g.fromLocal}</span></Td>
                    <Td r>{g.rows.length}</Td><Td r>{g.rows.reduce((a, r) => a + r.s.qty, 0).toLocaleString()}</Td>
                    <Td r><div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><button disabled={busy} onClick={() => sendQueue([g])} style={btnTealSm}>자동입력 보내기</button><button disabled={busy} onClick={() => download(g)} style={btnGhost}>엑셀</button></div></Td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={tbl}>
              <thead><tr><Th>일자</Th><Th>전표</Th><Th>구분</Th><Th>출고처 → 입고처</Th><Th>제품</Th><Th r>수량</Th><Th>EDI 입고처</Th><Th>상태</Th><Th></Th></tr></thead>
              <tbody>{view.slice(0, 500).map((r) => (
                <tr key={r.s.id} style={{ borderTop: `1px solid ${C.border}`, verticalAlign: "top" }}>
                  <Td>{r.date.slice(5)}</Td><Td>{r.s.slip_no}</Td><Td>{r.s.direction || "출고"}</Td>
                  <Td>{r.fromWp ? r.fromWp.name : r.fromLabel} → {r.toWp ? r.toWp.name : r.toLabel}
                    {r.issues.map((t, i) => <div key={i} style={{ fontSize: 11.5, color: C.red }}>{t}</div>)}
                    {r.match && <div style={{ fontSize: 11.5, color: C.green }}>EDI 이동 {r.match.move_code} ({r.match.move_date.slice(5)}){r.match.fuzzy ? " · 날짜·수량·장소로 찾음" : " · 전표번호 일치"}</div>}
                  </Td>
                  <Td>{r.s.pallet_code}</Td><Td r b>{r.s.qty.toLocaleString()}</Td>
                  <Td>{r.ordeCode ? <span style={{ fontSize: 12 }}>{r.ordeCode}·{r.ordeNumb}</span> : "—"}</Td>
                  <Td><Pill st={r.status} />{r.moveCode && <div style={{ fontSize: 11, color: C.hint }}>{r.moveCode}</div>}</Td>
                  <Td r>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {r.match && <button onClick={() => mark([r], "반영", r.match.move_code)} style={{ ...sm, color: C.green }}>연결</button>}
                      {r.status === "미반영" && <button onClick={() => mark([r], "제외")} title="EDI에 올리지 않을 건(테스트·AJ가 직접 등록 등)" style={sm}>제외</button>}
                      {r.status !== "미반영" && <button onClick={() => mark([r], null)} style={sm}>되돌리기</button>}
                    </div>
                  </Td>
                </tr>
              ))}</tbody>
            </table>
            {!view.length && <div style={{ fontSize: 13, color: C.sub, padding: 16 }}>이 기간·상태에 해당하는 PMS 건이 없어요.</div>}
          </div>
        </>
      )}
    </>
  );
}

// 건별 이동 현황: EDI 거래처 입출고 조회 기반. 누가 누구에게 몇 장 보냈는지, 입고확인 상태까지
function EdiMoves() {
  const [from, setFrom] = useState(isoD(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(isoD(new Date()));
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");
  const [iner, setIner] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setMsg("");
      const all = [];
      for (let p = 0; p < 40; p++) { // 한 번에 1000행까지만 주므로 페이지를 넘겨 받는다
        const { data, error } = await supabase.from("aj_move").select("move_code,move_date,item,from_name,to_name,move_type,iner,qty,chng,conf,note")
          .gte("move_date", from).lte("move_date", to).order("move_date", { ascending: false }).order("move_code").range(p * 1000, p * 1000 + 999);
        if (error) { if (alive) { setMsg("이동 내역을 불러오지 못했어요. letus_edi3.sql 실행 여부를 확인해주세요. (" + error.message + ")"); setBusy(false); } return; }
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      if (alive) { setRows(all); setBusy(false); }
    })();
    return () => { alive = false; };
  }, [from, to]);

  const items = [...new Set(rows.map((r) => r.item))].sort();
  const view = rows.filter((r) => (!item || r.item === item) && (!iner || r.iner === iner) && (!q || (r.from_name + " " + r.to_name + " " + (r.note || "")).includes(q)));
  const sumQty = view.reduce((a, r) => a + r.qty, 0);
  const unconf = view.filter((r) => r.conf !== "승인").length;
  const corr = view.filter((r) => r.qty < 0 || r.chng === "수정").length;

  const flows = useMemo(() => {
    const m = {};
    view.forEach((r) => { const k = r.from_name + "→" + r.to_name + "|" + r.item; m[k] = m[k] || { from: r.from_name, to: r.to_name, item: r.item, qty: 0, n: 0 }; m[k].qty += r.qty; m[k].n++; });
    return Object.values(m).sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty)).slice(0, 15);
  }, [view]);
  const net = useMemo(() => {
    const m = {};
    view.forEach((r) => {
      (m[r.from_name] = m[r.from_name] || { out: 0, inn: 0 }).out += r.qty;
      (m[r.to_name] = m[r.to_name] || { out: 0, inn: 0 }).inn += r.qty;
    });
    return Object.entries(m).map(([name, v]) => ({ name, ...v, net: v.inn - v.out })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12);
  }, [view]);
  const numC = (v) => ({ color: v < 0 ? C.red : C.text, fontWeight: v < 0 ? 600 : 400 });
  const inp = { fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 };

  return (
    <>
      <Head title="이동 현황" sub="AJ EDI 건별 이동 · 출발지 → 도착지, 수량, 입고확인 상태" />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <DateRange from={from} to={to} onApply={(f, t) => { setFrom(f); setTo(t); }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="출발지·도착지 검색" style={{ ...inp, width: 170 }} />
        <select value={item} onChange={(e) => setItem(e.target.value)} style={inp}><option value="">전체 제품</option>{items.map((i) => <option key={i} value={i}>{i}</option>)}</select>
        <select value={iner} onChange={(e) => setIner(e.target.value)} style={inp}><option value="">내부·외부 전체</option><option value="내부">내부(센터·사업장 간)</option><option value="외부">외부(수요처 간)</option></select>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Metric label="이동 건수" value={view.length.toLocaleString()} unit="건" tone="plain" />
        <Metric label="이동 수량" value={sumQty.toLocaleString()} unit="장" tone="info" />
        <Metric label="입고 미확인" value={unconf.toLocaleString()} unit="건" tone={unconf ? "warn" : "success"} />
        <Metric label="수정·정정" value={corr.toLocaleString()} unit="건" tone={corr ? "warn" : "success"} />
      </div>

      {busy ? <Splash text="불러오는 중…" /> : !rows.length ? (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, fontSize: 13, color: C.sub, lineHeight: 1.7 }}>이 기간의 이동 데이터가 아직 없어요. EDI 로그인 후 동기화가 돌면 채워져요.</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 14, marginBottom: 18 }}>
            <div style={{ overflowX: "auto" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>주요 흐름 (수량 상위 15)</div>
              <table style={tbl}>
                <thead><tr><Th>출발지</Th><Th>도착지</Th><Th>제품</Th><Th r>건</Th><Th r>수량</Th></tr></thead>
                <tbody>{flows.map((f, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}><Td>{f.from}</Td><Td>{f.to}</Td><Td>{f.item}</Td><Td r>{f.n}</Td><Td r b>{f.qty.toLocaleString()}</Td></tr>
                ))}</tbody>
              </table>
            </div>
            <div style={{ overflowX: "auto" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>순증감 (받은 수량 − 보낸 수량, 상위 12)</div>
              <table style={tbl}>
                <thead><tr><Th>작업장</Th><Th r>받음</Th><Th r>보냄</Th><Th r>순증감</Th></tr></thead>
                <tbody>{net.map((n) => (
                  <tr key={n.name} style={{ borderTop: `1px solid ${C.border}` }}><Td>{n.name}</Td><Td r>{n.inn.toLocaleString()}</Td><Td r>{n.out.toLocaleString()}</Td><Td r b><span style={numC(n.net)}>{n.net > 0 ? "+" : ""}{n.net.toLocaleString()}</span></Td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>이동 내역 {view.length > 300 ? `(최근 300건 / 전체 ${view.length.toLocaleString()}건)` : ""}</div>
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}>
              <thead><tr><Th>일자</Th><Th>출발지</Th><Th>도착지</Th><Th>제품</Th><Th r>수량</Th><Th>구분</Th><Th>입고확인</Th><Th>비고</Th></tr></thead>
              <tbody>{view.slice(0, 300).map((r, i) => (
                <tr key={r.move_code + i} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{r.move_date.slice(5)}</Td><Td>{r.from_name}</Td><Td>{r.to_name}</Td><Td>{r.item}</Td>
                  <Td r b><span style={numC(r.qty)}>{r.qty.toLocaleString()}</span></Td><Td>{r.iner}{r.move_type === "반납출고" ? " · 반납" : ""}{r.chng === "수정" ? " · 수정" : ""}</Td>
                  <Td><span style={{ color: r.conf === "승인" ? C.green : C.sub }}>{r.conf}</span></Td><Td>{r.note || ""}</Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// 같은 날짜·제품이 여러 EDI 계정(예: 15A 일반유형 + 15A 전용)에 있으면 합산해서 한 줄로
const mergeAccountRows = (rows) => {
  const m = new Map();
  rows.forEach((r) => {
    const k = r.stoc_date + "|" + r.item;
    const cur = m.get(k);
    if (!cur) { m.set(k, { ...r, raw: r.raw ? { ...r.raw } : null }); return; }
    ["last_stoc", "rental_in", "move_in", "move_out", "return_out", "this_stoc"].forEach((f) => { cur[f] = (cur[f] || 0) + (r[f] || 0); });
    ["CONT_STOC", "BACK_STOC", "CONF_STOC"].forEach((f) => {
      if (!cur.raw && !r.raw) return;
      const a = parseInt(cur.raw && cur.raw[f], 10) || 0, b = parseInt(r.raw && r.raw[f], 10) || 0;
      cur.raw = cur.raw || {}; cur.raw[f] = String(a + b);
    });
  });
  return [...m.values()].sort((a, b) => (a.stoc_date < b.stoc_date ? -1 : a.stoc_date > b.stoc_date ? 1 : 0));
};
const mergeByWorkplace = (rows) => {
  const m = new Map();
  rows.forEach((r) => { const k = r.workplace_no + "|" + r.item; const c = m.get(k); if (c) c.this_stoc += r.this_stoc; else m.set(k, { workplace_no: r.workplace_no, item: r.item, this_stoc: r.this_stoc }); });
  return [...m.values()];
};

function EdiStockView({ caps = {} }) {
  const nowMonth = billingMonthOf(new Date());
  const [wps, setWps] = useState([]);
  const [wpNo, setWpNo] = useState(1);
  const [q, setQ] = useState("");
  const [onlyData, setOnlyData] = useState(true);
  const [month, setMonth] = useState(nowMonth);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [item, setItem] = useState("");
  const [negMode, setNegMode] = useState("zero"); // 데이터는 음수 그대로 저장, 정산 계산에서만 0 처리(가이드: 마이너스 재고는 청구 대상 아님)
  const [basis, setBasis] = useState("this");   // 정산에 쓰는 재고 열: 전체/계약/회수/확인
  const [detail, setDetail] = useState(false);   // 일별 표에 계약·회수·확인재고 열 표시
  const [unit, setUnit] = useState(AJ_UNIT_DEFAULT);

  useEffect(() => {
    supabase.from("aj_workplace").select("*").order("no").limit(1000).then(({ data, error }) => {
      if (error) setMsg("작업장 목록을 불러오지 못했어요. letus_edi.sql 실행 여부를 확인해주세요. (" + error.message + ")");
      else setWps(data || []);
    });
  }, []);
  const per = useMemo(() => periodOf(month), [month]);
  const months = useMemo(() => { const out = []; let [y, m] = nowMonth.split("-").map(Number); for (let i = 0; i < 8; i++) { out.push(`${y}-${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } } return out; }, [nowMonth]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    supabase.from("aj_stock_daily").select("stoc_date,item,last_stoc,rental_in,move_in,move_out,return_out,this_stoc,raw")
      .eq("workplace_no", wpNo).gte("stoc_date", per.from).lte("stoc_date", per.to).order("stoc_date").limit(3000)
      .then(({ data, error }) => { if (!alive) return; setBusy(false); if (error) setMsg(error.message); else { setRows(mergeAccountRows(data || [])); } });
    return () => { alive = false; };
  }, [wpNo, per.from, per.to]);

  const wp = wps.find((w) => w.no === wpNo);
  const toggleSync = async () => {
    const next = !wp.sync_enabled;
    const { error } = await supabase.from("aj_workplace").update({ sync_enabled: next }).eq("no", wp.no);
    if (error) { setMsg(error.message); return; }
    setWps((l) => l.map((w) => (w.no === wp.no ? { ...w, sync_enabled: next } : w)));
  };
  const shown = wps.filter((w) => (!onlyData || w.last_synced || w.sync_enabled) &&(!q || (w.no + " " + w.name).includes(q)));
  const byItem = useMemo(() => {
    const m = {};
    rows.forEach((r) => { (m[r.item] = m[r.item] || []).push(r); });
    return m;
  }, [rows]);
  // 값이 있는 제품만
  const items = Object.keys(byItem).filter((k) => byItem[k].some((r) => r.this_stoc || r.move_in || r.move_out || r.rental_in || r.return_out)).sort();
  const cur = items.includes(item) ? item : items[0];
  const lastDate = rows.length ? rows[rows.length - 1].stoc_date : null;
  const complete = lastDate && lastDate >= per.to;
  const covered = new Set(rows.map((r) => r.stoc_date)).size;
  const divisor = complete ? per.days : Math.max(covered, 1);

  // EDI 원본(raw)에 있는 재고 열. 없으면(초기 시드 행) 금일재고 전체로 대신한다
  const rawN = (r, k) => { const v = r.raw && r.raw[k]; return v === undefined || v === null || v === "" ? null : parseInt(v, 10); };
  const stk = (r) => { const m = { cont: "CONT_STOC", back: "BACK_STOC", conf: "CONF_STOC" }[basis]; if (!m) return r.this_stoc; const v = rawN(r, m); return v === null ? r.this_stoc : v; };
  const calc = items.map((k) => {
    const list = byItem[k];
    const held = list.map((r) => negMode === "zero" ? Math.max(stk(r), 0) : stk(r));
    const sum = held.reduce((a, b) => a + b, 0);
    const avg = Math.ceil(sum / divisor);
    const neg = list.filter((r) => stk(r) < 0).length;
    const lastRow = list[list.length - 1];
    return { item: k, sum, avg, amount: avg * unit, neg, back: lastRow ? rawN(lastRow, "BACK_STOC") : null };
  });
  const total = calc.reduce((a, c) => a + c.amount, 0);

  const list = byItem[cur] || [];
  const mismatch = list.filter((r) => r.last_stoc + r.rental_in + r.move_in - r.move_out - r.return_out !== r.this_stoc);
  const jumps = list.filter((r) => Math.max(r.move_in, r.move_out) >= 3000);
  const negDays = list.filter((r) => r.this_stoc < 0);

  const chart = (() => {
    if (list.length < 2) return null;
    const vals = list.map((r) => r.this_stoc); const mn = Math.min(0, ...vals), mx = Math.max(...vals, 1);
    const W = 600, H = 150, x = (i) => 10 + (i * (W - 20)) / (list.length - 1), y = (v) => 10 + ((mx - v) * (H - 20)) / (mx - mn || 1);
    return { W, H, pts: list.map((r, i) => `${x(i)},${y(r.this_stoc)}`).join(" "), zero: y(0), mx, mn };
  })();
  const numC = (v) => ({ color: v < 0 ? C.red : C.text, fontWeight: v < 0 ? 600 : 400 });

  return (
    <>
      <Head title="EDI 재고·정산" sub="AJ EDI 일별 재고 기반 · 매일 전일자까지 자동 반영" />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <WorkplacePicker wps={wps} value={wpNo} onChange={setWpNo} filter={(w) => !onlyData || w.last_synced || w.sync_enabled || w.no === wpNo} />
        <label style={{ fontSize: 12, color: C.sub }}><input type="checkbox" checked={onlyData} onChange={(e) => setOnlyData(e.target.checked)} /> 데이터·동기화 대상만 ({wps.filter((w) => w.last_synced || w.sync_enabled).length}/{wps.length})</label>
        {caps.users && wp && (
          <button onClick={toggleSync} style={{ ...btnGhost, padding: "6px 12px", fontSize: 12, background: wp.sync_enabled ? C.teal : "transparent", color: wp.sync_enabled ? "#04342C" : C.text }}>
            {wp.sync_enabled ? "✓ 자동 동기화 대상" : "동기화 대상으로 지정"}
          </button>
        )}
        <span style={{ fontSize: 13, color: C.sub, marginLeft: 6 }}>정산월</span>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span style={{ fontSize: 12, color: C.hint }}>{per.from} ~ {per.to} ({per.days}일)</span>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Metric label="집계 기준일" value={lastDate ? lastDate.slice(5) : "—"} tone="plain" />
        <Metric label={complete ? "청구 예상액" : "청구 예상액 (진행중)"} value={won(total)} tone="info" />
        <Metric label="마이너스 재고" value={negDays.length} unit="일" tone={negDays.length ? "warn" : "success"} />
        <Metric label="수식 불일치" value={mismatch.length} unit="건" tone={mismatch.length ? "warn" : "success"} />
      </div>

      {busy ? <Splash text="불러오는 중…" /> : !rows.length ? (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, fontSize: 13, color: C.sub, lineHeight: 1.7 }}>
          이 작업장·기간의 EDI 데이터가 아직 없어요. {wp && !wp.last_synced ? "이 작업장은 아직 동기화 대상이 아니에요." : "동기화가 돌면 자동으로 채워져요."}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 8, fontSize: 12, color: C.sub }}>
            <span>마이너스 재고는</span>
            <select value={negMode} onChange={(e) => setNegMode(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
              <option value="zero">0장으로 계산</option><option value="raw">음수 그대로 계산</option>
            </select>
            <span>재고 기준</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
              <option value="this">금일재고 전체</option><option value="cont">계약재고</option><option value="back">회수재고</option><option value="conf">확인재고</option>
            </select>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} /> 일별 표에 계약·확인재고도 보기</label>
            <span>단가</span>
            <input type="number" value={unit} onChange={(e) => setUnit(Number(e.target.value) || 0)} style={{ width: 80, fontSize: 12, padding: "4px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }} />
            <span>원 · {complete ? `${per.days}일 기준` : `진행중: ${covered}일 기준 잠정`}</span>
          </div>
          <div style={{ overflowX: "auto", marginBottom: 18 }}>
            <table style={tbl}>
              <thead><tr><Th>제품</Th><Th r>일별 보유합계</Th><Th r>사용장수</Th><Th r>금액</Th><Th r>마이너스일</Th><Th r>회수재고(최근)</Th></tr></thead>
              <tbody>
                {calc.map((c) => (
                  <tr key={c.item} style={{ borderTop: `1px solid ${C.border}` }}>
                    <Td b>{c.item}</Td><Td r>{c.sum.toLocaleString()}</Td><Td r>{c.avg.toLocaleString()}</Td><Td r b>{c.amount.toLocaleString()}</Td><Td r><span style={numC(c.neg ? -1 : 0)}>{c.neg}</span></Td><Td r>{c.back ? c.back.toLocaleString() : ""}</Td>
                  </tr>
                ))}
                <tr style={{ borderTop: `1px solid ${C.border}`, background: "#eef0f3" }}>
                  <td colSpan={3} style={{ padding: "11px 6px", fontSize: 12, fontWeight: 600 }}>합계</td>
                  <td style={{ padding: "11px 6px", fontSize: 12, fontWeight: 600, textAlign: "right" }}>{won(total)}</td><td /><td />
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {items.map((k) => <button key={k} onClick={() => setItem(k)} style={{ ...btnGhost, padding: "6px 14px", background: k === cur ? C.teal : "transparent", color: k === cur ? "#04342C" : C.text }}>{k}</button>)}
          </div>
          {chart && (
            <svg viewBox={`0 0 ${chart.W} ${chart.H}`} style={{ width: "100%", maxHeight: 170, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 6 }}>
              <line x1="10" x2={chart.W - 10} y1={chart.zero} y2={chart.zero} stroke={C.border} strokeDasharray="4 3" />
              <polyline points={chart.pts} fill="none" stroke={C.teal} strokeWidth="2" />
              <text x="12" y="16" fontSize="10" fill={C.hint}>{chart.mx.toLocaleString()}</text>
              <text x="12" y={chart.H - 4} fontSize="10" fill={C.hint}>{chart.mn.toLocaleString()}</text>
            </svg>
          )}
          {(jumps.length > 0 || mismatch.length > 0) && (
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, lineHeight: 1.7 }}>
              {jumps.length > 0 && <div>⚠ 대량 이동일(3,000장 이상, 수기조정 의심): {jumps.map((r) => r.stoc_date.slice(5)).join(", ")}</div>}
              {mismatch.length > 0 && <div>⚠ 전일+입고−출고−반납 ≠ 금일: {mismatch.map((r) => r.stoc_date.slice(5)).join(", ")}</div>}
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}>
              <thead><tr><Th>일자</Th><Th r>전일</Th><Th r>렌탈입고</Th><Th r>이동입고</Th><Th r>이동출고</Th><Th r>반납/회수</Th><Th r>금일재고</Th><Th r>회수재고</Th>{detail && <><Th r>계약재고</Th><Th r>확인재고</Th></>}</tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.stoc_date} style={{ borderTop: `1px solid ${C.border}` }}>
                    <Td>{r.stoc_date.slice(5)}</Td><Td r>{r.last_stoc.toLocaleString()}</Td><Td r>{r.rental_in || ""}</Td><Td r>{r.move_in || ""}</Td><Td r>{r.move_out || ""}</Td><Td r>{r.return_out || ""}</Td>
                    <Td r b><span style={numC(r.this_stoc)}>{r.this_stoc.toLocaleString()}</span></Td>
                    <Td r>{rawN(r, "BACK_STOC") ? <span style={numC(rawN(r, "BACK_STOC"))}>{rawN(r, "BACK_STOC").toLocaleString()}</span> : ""}</Td>
                    {detail && [rawN(r, "CONT_STOC"), rawN(r, "CONF_STOC")].map((v, i) => <Td key={i} r>{v === null ? "-" : <span style={numC(v)}>{v.toLocaleString()}</span>}</Td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ─── 파렛트·단가 (관리자 전용): 규격·이미지 / 임대료(청구)·임차료(AJ) 단가 / AJ 명세서 ───────────
function PalletPricing({ caps = {} }) {
  const [tab, setTab] = useState("spec");
  const [pallets, setPallets] = useState([]);
  const [rates, setRates] = useState({});
  const [invoices, setInvoices] = useState([]);
  const [accts, setAccts] = useState([]);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(true);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState({}); // code -> 편집 중인 값

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true);
      const [p, r, iv, il, ac] = await Promise.all([
        supabase.from("aj_pallet").select("*").order("sort"),
        supabase.from("aj_cost_rate").select("*"),
        supabase.from("aj_invoice").select("*").order("month", { ascending: false }).order("account"),
        supabase.from("aj_invoice_line").select("*").order("id"),
        supabase.from("aj_account").select("code,name,label").order("first_seen"),
      ]);
      if (!alive) return;
      const er = p.error || r.error || iv.error || il.error;
      if (er) { setMsg("불러오지 못했어요. letus_edi5.sql 실행 여부를 확인해주세요. (" + er.message + ")"); setBusy(false); return; }
      setPallets((p.data || []).filter((x) => x.active !== false)); setRates(Object.fromEntries((r.data || []).map((x) => [x.code, x])));
      setInvoices(iv.data || []); setLines(il.data || []); setAccts(ac.data || []); setEdit({}); setBusy(false);
    })();
    return () => { alive = false; };
  }, [tick]);

  const setE = (code, k, v) => setEdit((e) => ({ ...e, [code]: { ...(e[code] || {}), [k]: v } }));
  const val = (p, k) => (edit[p.code] && edit[p.code][k] !== undefined ? edit[p.code][k] : p[k] ?? "");
  const rv = (code, k) => (edit[code] && edit[code]["r_" + k] !== undefined ? edit[code]["r_" + k] : (rates[code] || {})[k] ?? "");
  const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

  const saveSpec = async (p) => {
    const e = edit[p.code] || {};
    const patch = {};
    ["name", "category", "image_url"].forEach((k) => { if (e[k] !== undefined) patch[k] = e[k] || null; });
    ["width_mm", "depth_mm", "height_mm", "weight_kg"].forEach((k) => { if (e[k] !== undefined) patch[k] = numOrNull(e[k]); });
    if (!Object.keys(patch).length) return;
    const { error } = await supabase.from("aj_pallet").update({ ...patch, updated_at: new Date().toISOString() }).eq("code", p.code);
    if (error) setMsg(error.message); else setTick((t) => t + 1);
  };
  const savePrice = async (p) => {
    const e = edit[p.code] || {};
    const a = {};
    if (e.rent_price !== undefined) a.rent_price = numOrNull(e.rent_price);
    if (e.rent_mode !== undefined) a.rent_mode = e.rent_mode;
    if (e.rent_note !== undefined) a.rent_note = e.rent_note || null;
    const r = {};
    ["daily_rate", "move_fee", "ship_fee"].forEach((k) => { if (e["r_" + k] !== undefined) r[k] = numOrNull(e["r_" + k]); });
    let er = null;
    if (Object.keys(a).length) { const x = await supabase.from("aj_pallet").update({ ...a, updated_at: new Date().toISOString() }).eq("code", p.code); er = x.error; }
    if (!er && Object.keys(r).length) { const x = await supabase.from("aj_cost_rate").upsert({ code: p.code, ...(rates[p.code] || {}), ...r, updated_at: new Date().toISOString() }, { onConflict: "code" }); er = x.error; }
    if (er) setMsg(er.message); else setTick((t) => t + 1);
  };

  const inp = { fontSize: 13, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, width: "100%", boxSizing: "border-box" };
  const volume = (p) => (p.width_mm && p.depth_mm && p.height_mm ? ((p.width_mm * p.depth_mm * p.height_mm) / 1e9).toFixed(3) : "—");

  // ── AJ 명세서 탭 데이터 ──
  const months = [...new Set(invoices.map((i) => i.month))];
  const [mon, setMon] = useState("");
  const curMon = mon || months[0] || "";
  const invs = invoices.filter((i) => i.month === curMon);
  const [edi, setEdi] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const out = {};
      for (const iv of invs) {
        const items = [...new Set(lines.filter((l) => l.invoice_id === iv.id && l.kind === "구내용").flatMap((l) => l.item.split("+")))];
        if (!items.length || !iv.period_from) continue;
        let qy = supabase.from("aj_stock_daily").select("stoc_date,item,this_stoc").eq("workplace_no", 0).in("item", items).gte("stoc_date", iv.period_from).lte("stoc_date", iv.period_to);
        if (iv.account_code) qy = qy.eq("account", iv.account_code);
        const { data } = await qy.limit(3000);
        const rows = data || [];
        out[iv.id] = { sum: rows.reduce((a, r) => a + r.this_stoc, 0), days: new Set(rows.map((r) => r.stoc_date)).size };
      }
      if (alive) setEdi(out);
    })();
    return () => { alive = false; };
  }, [curMon, invoices.length, lines.length]); // eslint-disable-line

  return (
    <>
      <Head title="파렛트·단가" sub="관리자 전용 · 규격, 임대료(우리가 청구), 임차료(AJ가 청구), AJ 명세서" />
      {msg && <div style={{ background: C.redBg, color: C.red, padding: 12, borderRadius: 10, fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {[["spec", "규격·이미지"], ["price", "단가 (임대료·임차료)"], ["inv", "AJ 임차료 명세서"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btnGhost, padding: "7px 16px", background: tab === k ? C.teal : "transparent", color: tab === k ? "#04342C" : C.text, fontWeight: tab === k ? 600 : 400 }}>{l}</button>
        ))}
      </div>
      {busy ? <Splash text="불러오는 중…" /> : tab === "spec" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 14 }}>
          {pallets.map((p) => (
            <div key={p.code} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ height: 150, display: "flex", alignItems: "center", justifyContent: "center", background: "#f6f7f9", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                {p.image_url ? <img src={p.image_url} alt={p.code} loading="lazy" referrerPolicy="no-referrer" style={{ maxWidth: "100%", maxHeight: 150, objectFit: "contain" }} onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span style={{ color: C.hint, fontSize: 12 }}>이미지 없음</span>}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 700 }}>{p.code}</span>
                <span style={{ fontSize: 12, color: C.sub }}>{p.category}</span>
              </div>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>{p.name}</div>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                <div>규격 <b>{p.width_mm?.toLocaleString() ?? "—"} × {p.depth_mm?.toLocaleString() ?? "—"} × {p.height_mm ?? "—"}</b> mm</div>
                <div>중량 <b>{p.weight_kg ?? "—"}</b> kg · 부피 {volume(p)} m³</div>
              </div>
              {caps.users && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: C.teal }}>정보 수정</summary>
                  <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    <input style={inp} value={val(p, "name")} onChange={(e) => setE(p.code, "name", e.target.value)} placeholder="이름" />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                      {[["width_mm", "가로"], ["depth_mm", "세로"], ["height_mm", "높이"], ["weight_kg", "kg"]].map(([k, l]) => <input key={k} style={inp} type="number" step="any" value={val(p, k)} onChange={(e) => setE(p.code, k, e.target.value)} placeholder={l} />)}
                    </div>
                    <input style={inp} value={val(p, "image_url")} onChange={(e) => setE(p.code, "image_url", e.target.value)} placeholder="이미지 주소" />
                    <button onClick={() => saveSpec(p)} style={{ ...btnGreen, justifyContent: "center" }}>저장</button>
                  </div>
                </details>
              )}
            </div>
          ))}
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: C.hint }}>규격·중량·이미지 출처: AJ네트웍스 제품안내 (ajnetworks.co.kr)</div>
        </div>
      ) : tab === "price" ? (
        <>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, marginBottom: 10 }}>
            <b>임대료</b>는 우리가 브랜드(시공팀·업체)에 청구하는 장당 월 단가, <b>임차료</b>는 AJ가 우리에게 청구하는 단가예요. 구내용은 일 단가(원/장·일)이고, 운송비·수송용은 건별 비용이라 월 마진 계산에는 넣지 않았어요.
            15A는 시디즈 쿠팡출고분을 11A와 같은 13,200원으로 청구하고, 이케아 15A는 별도 계산서(15A 전용 계정)로 풀필에 <b>실비</b> 청구해요. 둘을 나누는 기준은 AJ 문의 후 정리할 예정이에요.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}>
              <thead><tr><Th>규격</Th><Th r>임대료(청구) 원/월</Th><Th>방식</Th><Th r>구내용 원/장·일</Th><Th r>월환산(30일)</Th><Th r>운송비 원/장</Th><Th r>수송용 원/장</Th><Th r>월 마진(구내용 기준)</Th><Th /></tr></thead>
              <tbody>
                {pallets.map((p) => {
                  const mode = val(p, "rent_mode") || "fixed";
                  const daily = Number(rv(p.code, "daily_rate")) || 0, rent = Number(val(p, "rent_price")) || 0;
                  const dirty = edit[p.code] && Object.keys(edit[p.code]).length;
                  return (
                    <tr key={p.code} style={{ borderTop: `1px solid ${C.border}` }}>
                      <Td b>{p.code}</Td>
                      <Td r>{mode === "actual" ? <span style={{ color: C.sub }}>실비</span> : <input style={{ ...inp, width: 100, textAlign: "right" }} type="number" value={val(p, "rent_price")} disabled={!caps.users} onChange={(e) => setE(p.code, "rent_price", e.target.value)} placeholder="미정" />}</Td>
                      <Td><select style={{ ...inp, width: 90 }} value={mode} disabled={!caps.users} onChange={(e) => setE(p.code, "rent_mode", e.target.value)}><option value="fixed">고정</option><option value="actual">실비</option></select></Td>
                      <Td r><input style={{ ...inp, width: 80, textAlign: "right" }} type="number" step="any" value={rv(p.code, "daily_rate")} disabled={!caps.users} onChange={(e) => setE(p.code, "r_daily_rate", e.target.value)} /></Td>
                      <Td r>{daily ? Math.round(daily * 30).toLocaleString() : "—"}</Td>
                      <Td r><input style={{ ...inp, width: 80, textAlign: "right" }} type="number" value={rv(p.code, "move_fee")} disabled={!caps.users} onChange={(e) => setE(p.code, "r_move_fee", e.target.value)} /></Td>
                      <Td r><input style={{ ...inp, width: 80, textAlign: "right" }} type="number" value={rv(p.code, "ship_fee")} disabled={!caps.users} onChange={(e) => setE(p.code, "r_ship_fee", e.target.value)} /></Td>
                      <Td r b>{mode === "actual" ? <span style={{ color: C.sub }}>실비(0)</span> : rent && daily ? <span style={{ color: rent - daily * 30 < 0 ? C.red : C.green }}>{Math.round(rent - daily * 30).toLocaleString()}</span> : "—"}</Td>
                      <Td>{caps.users && dirty ? <button onClick={() => savePrice(p)} style={{ ...btnGreen, padding: "5px 12px" }}>저장</button> : null}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: C.hint, marginTop: 8 }}>단가 근거: AJ 거래명세서(2026-09, 사용기간 8/26~9/25). 임대료는 현행 청구 단가(14C·18F 2,400 / 11A·15A 13,200 / 23E 7,000). 12A는 단가가 아직 없어요.</div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: C.sub }}>정산월</span>
            <select value={curMon} onChange={(e) => setMon(e.target.value)} style={{ fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }}>{months.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </div>
          {!invs.length && <div style={{ color: C.sub, fontSize: 13 }}>등록된 명세서가 없어요.</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <Metric label="임차료 공급가 합계" value={won(invs.reduce((a, i) => a + Number(i.supply || 0), 0))} tone="plain" />
            <Metric label="부가세 포함 청구 합계" value={won(invs.reduce((a, i) => a + Number(i.total || 0), 0))} tone="info" />
          </div>
          {invs.map((iv) => {
            const ls = lines.filter((l) => l.invoice_id === iv.id);
            const e = edi[iv.id];
            const gu = ls.find((l) => l.kind === "구내용");
            const gap = e && gu ? ((e.sum - Number(gu.qty)) / Number(gu.qty)) * 100 : null;
            return (
              <div key={iv.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <div><b>{iv.account}</b> <span style={{ color: C.sub, fontSize: 12 }}>{iv.period_from} ~ {iv.period_to} ({iv.days}일){iv.note ? ` · ${iv.note}` : ""}</span>
                    {caps.users && <select value={iv.account_code || ""} onChange={async (ev) => { await supabase.from("aj_invoice").update({ account_code: ev.target.value || null }).eq("id", iv.id); setTick((t) => t + 1); }} style={{ marginLeft: 8, fontSize: 12, padding: "3px 6px", border: `1px solid ${C.border}`, borderRadius: 6 }}><option value="">연결된 EDI 계정 없음</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.label || a.name || a.code}</option>)}</select>}</div>
                  <div style={{ fontSize: 13 }}>공급가 {won(iv.supply)} + 부가세 {won(iv.vat)} = <b>{won(iv.total)}</b></div>
                </div>
                <table style={tbl}>
                  <thead><tr><Th>제품</Th><Th>구분</Th><Th r>수량</Th><Th r>단가</Th><Th r>금액</Th></tr></thead>
                  <tbody>{ls.map((l) => <tr key={l.id} style={{ borderTop: `1px solid ${C.border}` }}><Td>{l.item}</Td><Td>{l.kind}</Td><Td r>{Number(l.qty).toLocaleString()}</Td><Td r>{l.unit_price == null ? "" : Number(l.unit_price).toLocaleString()}</Td><Td r b>{Number(l.amount).toLocaleString()}</Td></tr>)}</tbody>
                </table>
                {gu && (
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 8, lineHeight: 1.7 }}>
                    구내용 장·일 대조: 명세서 {Number(gu.qty).toLocaleString()} · EDI 전체합계 {e ? `${e.sum.toLocaleString()} (${e.days}일치)` : "계산 중/데이터 없음"}
                    {gap !== null && e.days >= iv.days ? <b style={{ color: Math.abs(gap) < 1 ? C.green : C.red }}> · 차이 {gap.toFixed(2)}%</b> : e && e.days < iv.days ? " · EDI 수집 기간이 짧아 비교 불가" : ""}
                    {!e || e.sum === 0 ? <span> · 이 계정의 EDI 데이터가 아직 수집되지 않았어요</span> : null}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function Billing({ ships, prices, caps = {} }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  // 월별 선택 옵션 (데이터에 있는 달 + 이번 달)
  const months = useMemo(() => {
    const set = new Set(ships.map((s) => (s.depart_at || "").slice(0, 7)).filter(Boolean));
    set.add(new Date().toISOString().slice(0, 7));
    return Array.from(set).sort().reverse();
  }, [ships]);
  const lines = useMemo(() => {
    const map = {};
    ships.filter((s) => DELIVERED.includes(s.status) && (s.depart_at || "").slice(0, 7) === month).forEach((s) => {
      const k = s.to_partner_name + "|" + s.pallet_code;
      map[k] = map[k] ? { ...map[k], qty: map[k].qty + s.qty } : { partner: s.to_partner_name, pallet: s.pallet_code, qty: s.qty };
    });
    return Object.values(map).map((l) => ({ ...l, price: prices[l.pallet] || 0, amount: l.qty * (prices[l.pallet] || 0) }));
  }, [ships, prices, month]);
  const total = lines.reduce((a, l) => a + l.amount, 0);

  const exportXlsx = () => {
    const rows = lines.map((l) => ({ 거래처: l.partner, 유형: l.pallet, 수량: l.qty, "단가(원)": l.price, "금액(원)": l.amount }));
    rows.push({ 거래처: "합계", 유형: "", 수량: lines.reduce((a, l) => a + l.qty, 0), "단가(원)": "", "금액(원)": total });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "정산");
    XLSX.writeFile(wb, `LETUS_정산_${month}.xlsx`);
  };

  return (
    <>
      <Head title="정산" sub="입고확인 이상 상태 · 출고월 기준 집계" action={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportXlsx} disabled={lines.length === 0} style={{ ...btnGhost, padding: "8px 14px", opacity: lines.length === 0 ? 0.5 : 1 }}>⬇ 엑셀 내보내기</button>
          {caps.billing && <button style={btnGreen}>정산 확정</button>}
        </div>} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: C.sub }}>정산 월</span>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Metric label="정산 거래처" value={new Set(lines.map((l) => l.partner)).size} unit="곳" tone="plain" />
        <Metric label="청구 총액" value={won(total)} tone="plain" />
        <Metric label="단가 적용" value="자동" tone="info" />
        <Metric label="정합성" value="자동" tone="success" />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>거래처</Th><Th>유형</Th><Th r>수량</Th><Th r>단가</Th><Th r>금액</Th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                <Td>{l.partner}</Td><Td>{l.pallet}</Td><Td r>{l.qty}</Td><Td r>{l.price.toLocaleString()}</Td><Td r b>{l.amount.toLocaleString()}</Td>
              </tr>
            ))}
            <tr style={{ borderTop: `1px solid ${C.border}`, background: "#eef0f3" }}>
              <td colSpan={4} style={{ padding: "11px 6px", fontSize: 12, fontWeight: 600 }}>합계</td>
              <td style={{ padding: "11px 6px", fontSize: 12, fontWeight: 600, textAlign: "right" }}>{won(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Note>선택한 달에 출고된 입고확인 이상 건만 집계되고, 거래처·단가의 단가가 자동 적용돼요. 엑셀 내보내기로 그대로 추출할 수 있어요.</Note>
    </>
  );
}

function PriceRow({ p, price, editable, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(price);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setVal(price); }, [price]);
  const commit = async () => {
    const n = Number(val);
    if (Number.isNaN(n) || n === price) { setEditing(false); return; }
    setBusy(true); await onSave(p.code, n); setBusy(false); setEditing(false);
  };
  return (
    <tr style={{ borderTop: `1px solid ${C.border}` }}>
      <Td b>{p.code}</Td><Td c={C.sub}>{p.usage}</Td>
      <td style={{ padding: "11px 6px", textAlign: "right" }}>
        {editable && editing ? (
          <input autoFocus type="number" value={val} disabled={busy}
            onChange={(e) => setVal(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setVal(price); setEditing(false); } }}
            style={{ width: 90, fontSize: 12, padding: "5px 7px", border: `1px solid ${C.teal}`, borderRadius: 6, textAlign: "right" }} />
        ) : (
          <span onClick={() => editable && setEditing(true)} style={{ fontSize: 12, cursor: editable ? "pointer" : "default", borderBottom: editable ? `1px dashed ${C.hint}` : "none", paddingBottom: 1 }}>
            {(price || 0).toLocaleString()}{editable && <span style={{ color: C.hint, marginLeft: 4 }}>✎</span>}
          </span>
        )}
      </td>
    </tr>
  );
}

function Master({ palletTypes, prices, partners, addPartner, bulkAddPartners, caps = {}, setPrice, ships = [], ajReqs = [], deletePartner, centers = [], addCenter, toggleCenter }) {
  const [cname, setCname] = useState("");
  const [name, setName] = useState(""); const [type, setType] = useState("업체");
  const [pq, setPq] = useState(""); const [pf, setPf] = useState("전체");
  const [preview, setPreview] = useState([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const filtered = partners.filter((p) => (pf === "전체" || p.type === pf) && (p.name.includes(pq) || pq === ""));
  // 보유 재고 또는 진행중(미확인 출고)이 있으면 삭제 불가
  const hasStock = (code) => palletTypes.some((t) => heldQty(ships, ajReqs, code, t.code) > 0)
    || ships.some((s) => !isReturn(s) && s.to_partner === code && !s.canceled && s.status === "출고완료");

  const normType = (v) => { const s = String(v || "").trim(); if (s.includes("시공")) return "시공팀"; if (s.includes("센터")) return "센터"; return "업체"; };
  const pickName = (r) => r["거래처명"] ?? r["거래처"] ?? r["이름"] ?? r["업체명"] ?? r["name"] ?? r["NAME"] ?? Object.values(r)[0] ?? "";
  const onFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      const rows = json.map((r) => ({ name: String(pickName(r)).trim(), type: normType(r["구분"] ?? r["유형"] ?? r["type"]) })).filter((r) => r.name);
      setPreview(rows); setMsg(rows.length === 0 ? "읽을 데이터가 없어요. 첫 행에 '거래처명' 열이 있는지 확인하세요." : "");
    } catch (err) { setMsg("엑셀을 읽지 못했어요: " + (err.message || err)); }
    e.target.value = "";
  };
  const doImport = async () => {
    setBusy(true);
    try { const res = await bulkAddPartners(preview); setMsg(`완료: ${res.added}개 등록, ${res.skipped}개 건너뜀(중복·빈값)`); setPreview([]); }
    catch (e) { setMsg("등록 실패: " + (e.message || e)); }
    setBusy(false);
  };
  return (
    <>
      <Head title="거래처" sub="EDI 작업장(시공팀·업체)이 거래처로 반영돼 있어요. 단가는 '파렛트·단가' 메뉴에서 관리해요" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>거래처 <span style={{ color: C.hint, fontWeight: 400 }}>({filtered.length}/{partners.length})</span></h3>
          <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="이름으로 검색…" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {["전체", "업체", "시공팀", "센터"].map((f) => {
              const on = pf === f;
              return <button key={f} onClick={() => setPf(f)} style={{ fontSize: 12, padding: "4px 11px", borderRadius: 20, cursor: "pointer", border: on ? "none" : `1px solid ${C.border}`, background: on ? C.teal : "#fff", color: on ? "#fff" : C.sub }}>{f}</button>;
            })}
          </div>
          <div style={{ maxHeight: 420, overflow: "auto", marginBottom: 12 }}>
            <table style={tbl}><tbody>
              {filtered.slice(0, 500).map((p) => { const locked = hasStock(p.code); return (
                <tr key={p.code} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{p.name}{/^[0-9]+$/.test(p.aj_code || "") && <span title={"EDI 작업장 " + p.aj_code} style={{ marginLeft: 6, fontSize: 10, color: C.teal, border: `1px solid ${C.teal}`, borderRadius: 4, padding: "0 4px" }}>EDI</span>}</Td>
                  <Td><TypeBadge t={p.type} /></Td>
                  {caps.master && <td style={{ padding: "8px 6px", textAlign: "right" }}>
                    {locked
                      ? <span style={{ fontSize: 10, color: C.hint }} title="보유 재고/진행중 건이 있어 삭제 불가">재고있음</span>
                      : <button onClick={() => deletePartner(p)} style={{ fontSize: 11, color: C.red, background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }} title="거래처 삭제">삭제</button>}
                  </td>}
                </tr>
              ); })}
              {filtered.length === 0 && <tr><td colSpan={caps.master ? 3 : 2} style={{ padding: "16px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>검색 결과 없음</td></tr>}
            </tbody></table>
          </div>
          {caps.master && <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 7 }}>새 거래처 등록</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="거래처명" style={{ flex: 1, minWidth: 0, fontSize: 13, padding: "7px 9px", border: `1px solid ${C.border}`, borderRadius: 6 }} />
              <select value={type} onChange={(e) => setType(e.target.value)} style={{ fontSize: 13, padding: "7px 9px", border: `1px solid ${C.border}`, borderRadius: 6 }}><option>업체</option><option>시공팀</option><option>센터</option></select>
            </div>
            <button onClick={async () => { if (name) { await addPartner(name, type); setName(""); } }} disabled={!name} style={{ width: "100%", fontSize: 13, padding: 9, borderRadius: 8, border: "none", cursor: "pointer", background: !name ? "#c7cad1" : C.teal, color: "#fff" }}>등록</button>
          </div>}
          {caps.master && <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 12 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 7 }}>엑셀 일괄 등록</div>
            <label style={{ display: "inline-block", fontSize: 13, padding: "9px 14px", borderRadius: 8, border: `1px dashed ${C.teal}`, cursor: "pointer", color: C.tealDk, background: C.tealBg }}>
              📄 엑셀 파일 선택 (.xlsx)
              <input type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
            </label>
            {preview.length > 0 && (
              <div style={{ marginTop: 10, background: "#eef0f3", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{preview.length}개 행을 읽었어요. 등록할까요?</div>
                <div style={{ fontSize: 11, color: C.hint, margin: "4px 0 8px" }}>예: {preview.slice(0, 3).map((r) => `${r.name}(${r.type})`).join(", ")}{preview.length > 3 ? " …" : ""}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={doImport} disabled={busy} style={{ ...btnTealSm, padding: "7px 16px" }}>{busy ? "등록 중…" : "등록"}</button>
                  <button onClick={() => setPreview([])} style={{ ...btnGhost, padding: "7px 16px" }}>취소</button>
                </div>
              </div>
            )}
            {msg && <div style={{ fontSize: 12, color: msg.startsWith("완료") ? C.green : C.red, marginTop: 8 }}>{msg}</div>}
            <div style={{ fontSize: 11, color: C.hint, marginTop: 8, lineHeight: 1.6 }}>양식: 첫 행에 <b>거래처명</b>, <b>구분</b>(업체/시공팀/센터) 열. 구분이 없으면 업체로 처리돼요. 이미 있는 이름은 자동 건너뜀.</div>
          </div>}
        </div>

        {/* 센터 관리 (우리 보유 거점) */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600 }}>센터 관리 <span style={{ color: C.hint, fontWeight: 400, fontSize: 11 }}>· 우리 보유 거점</span></h3>
          <p style={{ fontSize: 11, color: C.hint, margin: "0 0 10px", lineHeight: 1.6 }}>센터는 우리 재고를 두는 곳이라 거래처와 분리해서 관리해요. 거래처로 만들면 재고가 안 맞아요.</p>
          <div style={{ maxHeight: 220, overflow: "auto", marginBottom: 12 }}>
            <table style={tbl}><tbody>
              {centers.map((c) => (
                <tr key={c} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{c}</Td>
                  {caps.master && <td style={{ padding: "8px 6px", textAlign: "right" }}>
                    <button onClick={() => toggleCenter(c, false)} style={{ fontSize: 11, color: C.red, background: "none", border: "none", cursor: "pointer" }} title="비활성화">숨김</button>
                  </td>}
                </tr>
              ))}
              {centers.length === 0 && <tr><td style={{ padding: "16px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>등록된 센터가 없어요. (letus_centers.sql 실행 필요)</td></tr>}
            </tbody></table>
          </div>
          {caps.master && <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, display: "flex", gap: 6 }}>
            <input value={cname} onChange={(e) => setCname(e.target.value)} placeholder="새 센터명" style={{ flex: 1, minWidth: 0, fontSize: 13, padding: "7px 9px", border: `1px solid ${C.border}`, borderRadius: 6 }} />
            <button onClick={async () => { if (cname.trim()) { await addCenter(cname.trim()); setCname(""); } }} disabled={!cname.trim()} style={{ fontSize: 13, padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: !cname.trim() ? "#c7cad1" : C.teal, color: "#fff" }}>추가</button>
          </div>}
        </div>
      </div>
      <Note>거래처가 많아져도 검색·구분 필터로 빠르게 찾을 수 있어요. 센터는 별도 '센터 관리'에서 추가/숨김 하세요.</Note>
    </>
  );
}

const ROLE_BADGE = {
  관리자: { bg: C.redBg, fg: C.red }, 운송팀: { bg: C.tealBg, fg: C.tealDk },
  정산담당: { bg: C.blueBg, fg: C.blue }, 협력업체: { bg: "#eef0f3", fg: C.sub },
  AJ: { bg: C.amberBg, fg: C.amber },
};

// 내 설정 — 계정 정보 + 비밀번호 변경
function Settings({ session, role, partners }) {
  const [prof, setProf] = useState(null);
  const [name, setName] = useState(""); const [company, setCompany] = useState(""); const [phone, setPhone] = useState("");
  const [savingP, setSavingP] = useState(false); const [pmsg, setPmsg] = useState("");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [savingPw, setSavingPw] = useState(false); const [pwmsg, setPwmsg] = useState("");

  useEffect(() => {
    supabase.from("profiles").select("name, company, phone, partner_code, active").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => { setProf(data || {}); setName(data?.name || ""); setCompany(data?.company || ""); setPhone(data?.phone || ""); });
  }, [session.user.id]);

  const rb = ROLE_BADGE[role] || ROLE_BADGE.협력업체;
  const myPartner = prof?.partner_code ? partners.find((p) => p.code === prof.partner_code) : null;
  const joined = session.user.created_at ? fmtDT(session.user.created_at) : "—";

  const saveProfile = async () => {
    setSavingP(true); setPmsg("");
    const { error } = await supabase.from("profiles").upsert({ id: session.user.id, name: name || null, company: company || null, phone: phone || null }, { onConflict: "id" });
    setSavingP(false); setPmsg(error ? "저장 실패: " + error.message : "저장됐어요.");
  };
  const changePw = async () => {
    if (pw.length < 6) { setPwmsg("비밀번호는 6자 이상이어야 해요."); return; }
    if (pw !== pw2) { setPwmsg("두 비밀번호가 달라요."); return; }
    setSavingPw(true); setPwmsg("");
    const { error } = await supabase.auth.updateUser({ password: pw });
    setSavingPw(false);
    if (error) setPwmsg("변경 실패: " + error.message);
    else { setPw(""); setPw2(""); setPwmsg("비밀번호가 변경됐어요."); }
  };

  const Row = ({ label, children }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${C.border}`, gap: 12 }}>
      <span style={{ fontSize: 12, color: C.sub }}>{label}</span>
      <span style={{ fontSize: 13, textAlign: "right" }}>{children}</span>
    </div>
  );

  return (
    <>
      <Head title="내 설정" sub="계정 정보 확인 및 비밀번호 변경" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start", maxWidth: 760 }}>
        {/* 계정 정보 */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px" }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>계정 정보</h3>
          <Row label="이메일">{session.user.email}</Row>
          <Row label="역할"><span style={{ fontSize: 11, color: rb.fg, background: rb.bg, padding: "2px 9px", borderRadius: 20 }}>{role}</span></Row>
          {role === "협력업체" && <Row label="소속 거래처">{myPartner ? `${myPartner.name} · ${myPartner.type}` : <span style={{ color: C.amber }}>미지정 (관리자 문의)</span>}</Row>}
          <Row label="가입일">{joined}</Row>
          <Row label="상태"><span style={{ color: prof?.active === false ? C.red : C.green }}>{prof?.active === false ? "비활성" : "활성"}</span></Row>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>이름</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }} />
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>연락처</div>
            <input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} inputMode="numeric" placeholder="휴대폰 번호" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>회사명</div>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="회사명" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
            <button onClick={saveProfile} disabled={savingP} style={{ ...btnTeal, width: "100%", justifyContent: "center" }}>{savingP ? "저장 중…" : "정보 저장"}</button>
            {pmsg && <div style={{ fontSize: 12, color: pmsg.startsWith("저장됐") ? C.green : C.red, marginTop: 8 }}>{pmsg}</div>}
          </div>
        </div>

        {/* 비밀번호 변경 */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>비밀번호 변경</h3>
          <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="새 비밀번호(6자 이상)" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }} />
          <input value={pw2} onChange={(e) => setPw2(e.target.value)} type="password" placeholder="새 비밀번호 확인" onKeyDown={(e) => e.key === "Enter" && changePw()} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
          <button onClick={changePw} disabled={savingPw} style={{ ...btnTeal, width: "100%", justifyContent: "center" }}>{savingPw ? "변경 중…" : "비밀번호 변경"}</button>
          {pwmsg && <div style={{ fontSize: 12, color: pwmsg.startsWith("비밀번호가") ? C.green : C.red, marginTop: 8 }}>{pwmsg}</div>}
          <p style={{ fontSize: 11, color: C.hint, marginTop: 12, lineHeight: 1.6 }}>비밀번호를 잊었을 땐 로그아웃 후 로그인 화면의 "비밀번호를 잊으셨나요?"를 이용하거나, 관리자에게 초기화를 요청하세요.</p>
        </div>
      </div>
    </>
  );
}

// 검색 가능한 거래처 선택기 (수백 개여도 검색으로 빠르게). 드롭다운은 화면 고정(fixed)으로 표에 안 갇힘.
function PartnerPicker({ value, partners, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const cur = partners.find((p) => p.code === value);
  const matches = partners.filter((p) => !q || p.name.includes(q) || (p.type || "").includes(q)).slice(0, 50);
  const openIt = () => { const r = btnRef.current.getBoundingClientRect(); setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) }); setQ(""); setOpen(true); };
  return (
    <div style={{ maxWidth: 240 }}>
      <button ref={btnRef} onClick={() => (open ? setOpen(false) : openIt())} style={{ width: "100%", textAlign: "left", fontSize: 12, padding: "6px 9px", borderRadius: 7, border: `1px solid ${value ? C.border : C.amber}`, background: "#fff", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <span style={{ color: cur ? C.text : C.amber, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur ? `${cur.name} · ${cur.type}` : "(미지정 — 아무 것도 안 보임)"}</span>
        <span style={{ color: C.hint, flexShrink: 0 }}>▾</span>
      </button>
      {open && rect && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 61, boxShadow: "0 6px 20px rgba(0,0,0,.15)" }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="거래처 검색…" style={{ width: "100%", boxSizing: "border-box", fontSize: 12, padding: "8px 10px", border: "none", borderBottom: `1px solid ${C.border}`, outline: "none" }} />
            <div style={{ maxHeight: 240, overflow: "auto" }}>
              <button onClick={() => { onChange(null); setOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", fontSize: 12, padding: "8px 10px", border: "none", borderBottom: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", color: C.amber }}>(미지정)</button>
              {matches.map((p) => (
                <button key={p.code} onClick={() => { onChange(p.code); setOpen(false); }} style={{ display: "flex", justifyContent: "space-between", width: "100%", textAlign: "left", fontSize: 12, padding: "8px 10px", border: "none", borderBottom: `1px solid ${C.border}`, background: p.code === value ? C.tealBg : "#fff", cursor: "pointer" }}>
                  <span>{p.name}</span><TypeBadge t={p.type} />
                </button>
              ))}
              {matches.length === 0 && <div style={{ padding: "10px", fontSize: 12, color: C.hint }}>검색 결과 없음</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
function Users({ users, partners, centers = [], setUserRole, setUserPartner, setUserActive, setUserCenters, adminResetPassword, meId }) {
  const [q, setQ] = useState("");
  const isPending = (u) => u.role === "협력업체" && !u.partner_code && u.active;
  const pendingCount = users.filter(isPending).length;
  const list = users.filter((u) => !q || (u.name || "").includes(q) || (u.email || "").includes(q) || (u.company || "").includes(q) || (u.role || "").includes(q));
  // 승인 대기(미지정 협력업체)를 맨 위로 정렬
  const sorted = [...list].sort((a, b) => (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0));
  return (
    <>
      <Head title="사용자 관리" sub="가입자별 역할·소속 거래처·계정 상태를 관리해요 · 관리자 전용" />
      {pendingCount > 0 && (
        <div style={{ background: C.amberBg, color: C.amber, fontSize: 13, padding: "9px 14px", borderRadius: 8, marginBottom: 14 }}>
          ⚠ 소속 거래처 미지정 협력업체 <b>{pendingCount}명</b> — 거래처를 연결해야 데이터를 볼 수 있어요(승인 대기).
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·이메일·회사·역할로 검색…" style={{ width: "100%", maxWidth: 340, boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 14 }} />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>사용자</Th><Th>역할</Th><Th>담당 센터 / 소속 거래처</Th><Th>계정</Th></tr></thead>
          <tbody>
            {sorted.map((u) => {
              const me = u.id === meId; const rb = ROLE_BADGE[u.role] || ROLE_BADGE.협력업체; const pending = isPending(u);
              return (
                <tr key={u.id} style={{ borderTop: `1px solid ${C.border}`, background: pending ? C.amberBg + "55" : u.active ? "transparent" : "#fafafa", opacity: u.active ? 1 : 0.6 }}>
                  <Td>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{u.company || u.name || "(이름없음)"} {me && <span style={{ fontSize: 10, color: C.teal }}>(나)</span>}</div>
                    <div style={{ fontSize: 11, color: C.hint }}>{u.email || u.id.slice(0, 8)}</div>
                  </Td>
                  <Td>
                    <select value={u.role} disabled={me} onChange={(e) => setUserRole(u.id, e.target.value)}
                      style={{ fontSize: 12, padding: "5px 8px", borderRadius: 7, border: `1px solid ${C.border}`, background: me ? C.page : `${rb.bg}`, color: rb.fg }}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {me && <div style={{ fontSize: 10, color: C.hint, marginTop: 2 }}>본인 변경 불가</div>}
                  </Td>
                  <Td>
                    {u.role === "협력업체" ? (
                      <PartnerPicker value={u.partner_code || ""} partners={partners} onChange={(code) => setUserPartner(u.id, code)} />
                    ) : u.role === "관리자" ? (
                      <span style={{ fontSize: 12, color: C.hint }}>전체 센터</span>
                    ) : u.role === "운송팀" ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 260 }}>
                        {centers.map((c) => { const on = (u.center_codes || []).includes(c); return (
                          <button key={c} onClick={() => setUserCenters(u.id, on ? (u.center_codes || []).filter((x) => x !== c) : [...(u.center_codes || []), c])} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 14, cursor: "pointer", border: on ? "none" : `1px solid ${C.border}`, background: on ? C.teal : "#fff", color: on ? "#fff" : C.sub }}>{c}</button>
                        ); })}
                        {(!u.center_codes || u.center_codes.length === 0) && <span style={{ fontSize: 10, color: C.hint, alignSelf: "center" }}>미배정=전체</span>}
                      </div>
                    ) : <span style={{ fontSize: 12, color: C.hint }}>—</span>}
                  </Td>
                  <Td>
                    {me ? <span style={{ fontSize: 11, color: C.hint }}>—</span> : (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button onClick={() => setUserActive(u.id, !u.active)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", border: `1px solid ${u.active ? C.border : C.red}`, background: u.active ? "#fff" : C.redBg, color: u.active ? C.sub : C.red }}>
                          {u.active ? "활성 · 비활성화" : "비활성 · 활성화"}
                        </button>
                        <button onClick={() => adminResetPassword(u)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", border: `1px solid ${C.border}`, background: "#fff", color: C.sub }}>비번 초기화</button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={4} style={{ padding: "20px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>가입한 사용자가 없어요.</td></tr>}
          </tbody>
        </table>
      </div>
      <Note>협력업체는 <b>소속 거래처를 지정해야</b> 그 거래처로 온 출고 건만 보여요(미지정=차단). <b>비활성화</b>한 계정은 로그인해도 접근이 막혀요. 모든 권한은 DB(RLS)에서도 강제됩니다.</Note>
    </>
  );
}
