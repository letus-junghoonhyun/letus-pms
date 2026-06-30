import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import QRCode from "qrcode";
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
const DirBadge = ({ s }) => isMove(s)
  ? <span style={{ fontSize: 10, color: "#5b3aa6", background: "#efe8ff", padding: "1px 6px", borderRadius: 10 }}>센터이동</span>
  : isReturn(s)
    ? <span style={{ fontSize: 10, color: "#854F0B", background: "#FAEEDA", padding: "1px 6px", borderRadius: 10 }}>반납</span>
    : <span style={{ fontSize: 10, color: "#185FA5", background: "#E6F1FB", padding: "1px 6px", borderRadius: 10 }}>출고</span>;
const won = (n) => "₩" + (n || 0).toLocaleString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + Math.random());

const ST = {
  출고완료: { bg: C.blueBg, fg: C.blue }, 입고확인: { bg: C.greenBg, fg: C.green },
  회수요청: { bg: C.amberBg, fg: C.amber }, 회수완료: { bg: "#eef0f3", fg: C.sub }, 미회수: { bg: C.redBg, fg: C.red },
};
const Pill = ({ status }) => {
  const s = ST[status] ?? { bg: C.page, fg: C.sub };
  return <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>{status}</span>;
};
const Metric = ({ label, value, unit, tone }) => {
  const m = { danger: { bg: C.redBg, fg: C.red }, warn: { bg: C.amberBg, fg: C.amber }, info: { bg: C.blueBg, fg: C.blue }, success: { bg: C.greenBg, fg: C.green }, plain: { bg: "#eef0f3", fg: C.text } }[tone] ?? {};
  return (
    <div style={{ background: m.bg, borderRadius: 10, padding: "12px 14px", flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: tone === "plain" ? C.sub : m.fg }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 500, marginTop: 2, color: m.fg }}>{value}{unit && <span style={{ fontSize: 12, color: tone === "plain" ? C.hint : m.fg }}> {unit}</span>}</div>
    </div>
  );
};
const Head = ({ title, sub, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
    <div><h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2><p style={{ margin: "2px 0 0", fontSize: 12, color: C.hint }}>{sub}</p></div>
    {action}
  </div>
);
const Note = ({ children }) => <p style={{ fontSize: 11, color: C.hint, marginTop: 14, lineHeight: 1.6 }}>{children}</p>;
const tbl = { width: "100%", borderCollapse: "collapse" };
const btnTeal = { fontSize: 12, padding: "8px 14px", borderRadius: 8, border: "none", background: C.teal, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 };
const btnTealSm = { fontSize: 11, padding: "5px 10px", borderRadius: 7, border: "none", background: C.teal, color: "#fff", cursor: "pointer" };
const btnGhost = { fontSize: 11, padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", color: C.text };
const btnGreen = { fontSize: 12, padding: "8px 14px", borderRadius: 8, border: "none", background: C.green, color: "#fff", cursor: "pointer" };
const Td = ({ children, r, b, c }) => <td style={{ padding: "11px 6px", fontSize: 12, textAlign: r ? "right" : "left", fontWeight: b ? 600 : 400, color: c ?? C.text }}>{children}</td>;
const Th = ({ children, r }) => <th style={{ fontSize: 11, color: C.hint, fontWeight: 400, textAlign: r ? "right" : "left", padding: "9px 6px" }}>{children}</th>;
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
  관리자: ["현황", "출고", "확인", "회수", "재고", "AJ", "정산", "마스터", "사용자", "설정"],
  운송팀: ["현황", "출고", "확인", "회수", "재고", "AJ", "정산", "마스터", "설정"],
  정산담당: ["현황", "재고", "정산", "마스터", "설정"],
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
          {mode === "signup" && <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="연락처(휴대폰)" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />}
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
    if (direction === "출고") {
      const over = valid.find((l) => l.qty > centerStock(ships, ajReqs, center, l.pallet));
      if (over) { alert(`${center} 재고 부족: ${over.pallet} 재고 ${centerStock(ships, ajReqs, center, over.pallet)}장, 요청 ${over.qty}장`); return; }
    }
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
          operator_name: me.name || null, operator_phone: me.phone || null, out_sign_url: outSign || null, created_by: session.user.id,
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
      const rows = valid.map((l) => ({
        id: uid(), type: req.type, pallet_code: l.pallet, qty: l.qty,
        center: req.center || null, partner_code: req.partner?.code || null, partner_name: req.partner?.name || null,
        status: "요청", note: req.note || null, created_by: session.user.id,
      }));
      const { error } = await supabase.from("aj_request").insert(rows);
      if (error) throw error;
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

  // 센터 간 재고 이동 (출발센터 − / 도착센터 +)
  const transferCenters = async (fromC, toC, lines, photos = [], vehicleNo = null, note = null) => {
    const valid = (lines || []).filter((l) => l.pallet && l.qty > 0);
    if (!valid.length) { alert("수량을 1개 이상 입력하세요."); return; }
    if (fromC === toC) { alert("출발 센터와 도착 센터가 같아요."); return; }
    const over = valid.find((l) => l.qty > centerStock(ships, ajReqs, fromC, l.pallet));
    if (over) { alert(`${fromC} 재고 부족: ${over.pallet} 재고 ${centerStock(ships, ajReqs, fromC, over.pallet)}장, 요청 ${over.qty}장`); return; }
    try {
      const batchId = uid();
      const nowISO = new Date().toISOString();
      const rows = [];
      for (const l of valid) {
        const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
        if (e1) throw e1;
        rows.push({ id: uid(), slip_no: slip, to_partner: null, to_partner_name: toC, pallet_code: l.pallet, qty: l.qty, status: "출고완료", direction: "이동", center: fromC, to_center: toC, depart_at: nowISO, batch_id: batchId, out_photos: photos.length ? photos : null, vehicle_no: vehicleNo || null, note: note || null, operator_name: me.name || null, operator_phone: me.phone || null, created_by: session.user.id });
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

  const setStatus = async (s, newStatus, mvType, inPhotos, inSign) => {
    try {
      const patch = { status: newStatus };
      if (newStatus === "입고확인") {
        if (!s.confirmed_at) patch.confirmed_at = new Date().toISOString();
        patch.receiver_name = me.name || null;       // 입고확인한 담당자 자동 기록
        if (inSign) patch.in_sign_url = inSign;
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
    { key: "재고", label: "재고 현황" }, { key: "AJ", label: "AJ 요청" },
    { key: "정산", label: "정산" }, { key: "마스터", label: "거래처·단가" },
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
        <div style={{ marginTop: 18, padding: "0 8px" }}>
          <button onClick={() => setNav("설정")} style={{ display: "block", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", marginBottom: 8 }}>
            <div style={{ color: "#6b7494", fontSize: 11 }}>{session.user.email}</div>
            <div style={{ color: C.teal, fontSize: 11 }}>{role} · 내 설정 ›</div>
          </button>
          <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 11, color: C.side, background: "transparent", border: "1px solid #3a4258", borderRadius: 6, padding: "5px 9px", cursor: "pointer" }}>로그아웃</button>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, padding: "20px 18px 80px", overflow: "auto" }}>
        {loading ? <Splash text="데이터 불러오는 중…" /> : err ? (
          <div style={{ background: C.redBg, color: C.red, padding: 16, borderRadius: 10, fontSize: 13 }}>
            {err}<br /><br />혹시 supabase.js에 anon key를 안 넣었거나, 쓰기 권한(RLS) 설정이 필요할 수 있어요. 화면을 캡처해서 Claude에게 물어보세요.
          </div>
        ) : focusBatch ? (
          <QuickConfirm rows={ships.filter((s) => (s.batch_id || s.id) === focusBatch)} setStatus={setStatus} onClose={() => { setFocusBatch(null); window.history.replaceState({}, "", window.location.pathname); }} />
        ) : (
          <>
            {nav === "현황" && <Dashboard {...{ ships, ajReqs, flash, setStatus, setNav, caps, palletTypes, editShipment, cancelShipment, resetData, confirmAjSupply }} />}
            {nav === "출고" && caps.outbound && <Outbound partners={partnersFull} palletTypes={palletTypes} ships={ships} ajReqs={ajReqs} centers={centerList} myCenters={myCenters} onRegister={register} onTransfer={transferCenters} setNav={setNav} />}
            {nav === "반납" && caps.returnReg && <ReturnRegister partners={partnersFull} palletTypes={palletTypes} ships={ships} ajReqs={ajReqs} centers={centerList} onRegister={register} onAjReturn={createAjRequest} />}
            {nav === "확인" && <Confirm {...{ ships, setStatus, caps, ajReqs, confirmAjSupply }} />}
            {nav === "회수" && caps.operate && <Recovery {...{ ships, ajReqs, partners: partnersFull, palletTypes, centers: centerList, recoverToCenter, recoverToAj }} />}
            {nav === "재고" && caps.inventory && <Inventory {...{ ships, ajReqs, partners: partnersFull, palletTypes, centers: centerList }} />}
            {nav === "AJ" && (caps.aj || caps.ajWorker) && <AjLink {...{ ajReqs, palletTypes, createAjRequest, completeAjRequest, confirmAjSupply, cancelAjRequest, ships, caps, centers: centerList }} />}
            {nav === "정산" && <Billing {...{ ships, prices, caps }} />}
            {nav === "마스터" && <Master {...{ palletTypes, prices, partners: partnersFull, addPartner, bulkAddPartners, caps, setPrice, ships, ajReqs, deletePartner, centers, addCenter, toggleCenter }} />}
            {nav === "사용자" && caps.users && <Users {...{ users, partners: partnersFull, centers: centerList, setUserRole, setUserPartner, setUserActive, setUserCenters, adminResetPassword, meId: session.user.id }} />}
            {nav === "설정" && <Settings session={session} role={role} partners={partnersFull} />}
          </>
        )}
      </main>

      {/* 모바일 하단 탭바 */}
      <nav className="lp-bottom" style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.dark, display: "none", justifyContent: "space-around", padding: "8px 4px", zIndex: 10 }}>
        {items.slice(0, 5).map((it) => {
          const on = nav === it.key;
          return <button key={it.key} onClick={() => setNav(it.key)} style={{ background: "none", border: "none", color: on ? C.teal : C.side, fontSize: 11, cursor: "pointer", padding: "2px 6px" }}>{it.label}</button>;
        })}
      </nav>

      <style>{`
        @media (max-width: 720px) {
          .lp-side { display: none !important; }
          .lp-bottom { display: flex !important; }
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

function Dashboard({ ships, ajReqs = [], flash, setStatus, setNav, caps = {}, palletTypes = [], editShipment, cancelShipment, resetData, confirmAjSupply }) {
  const [tab, setTab] = useState("전체");
  const [edit, setEdit] = useState(null);
  const [slipBatch, setSlipBatch] = useState(null);
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const tabs = ["전체", "출고완료", "입고확인", "미회수"];
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = ships.filter((s) => (s.depart_at || "").slice(0, 10) === todayStr).reduce((a, s) => a + s.qty, 0);
  const unrec = ships.filter(isUnrecovered).reduce((a, s) => a + s.qty, 0);
  const waiting = ships.filter((s) => s.status === "출고완료").length;
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
        <Metric label="총 건수" value={ships.length} unit="건" tone="plain" />
      </div>
      {/* 날짜 조회 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
        <span style={{ color: C.hint }}>~</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 13, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
        <button onClick={() => quick(7)} style={btnGhost}>최근7일</button>
        <button onClick={() => quick(30)} style={btnGhost}>최근30일</button>
        {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} style={{ ...btnGhost, color: C.sub }}>전체</button>}
      </div>
      <Tabs tabs={tabs} tab={tab} setTab={setTab} count={cnt} />
      <div style={{ overflowX: "auto" }}>
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
                  <Td c={C.sub}>{s.slip_no}</Td><Td>{s.pallet_code}</Td><Td r>{s.qty}</Td>
                  <Td>{fromOf(s)}</Td><Td>{toOf(s)}</Td>
                  <Td c={C.sub}>{fmtDT(s.depart_at)}</Td>
                  <Td c={s.confirmed_at ? C.text : C.hint}>{fmtDT(s.confirmed_at)}</Td>
                  <Td c={danger ? C.red : s.status === "회수완료" ? C.hint : C.text} b={danger}>{s.status === "회수완료" ? "—" : d + "일"}</Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {/* 입고확인: 협력업체는 본인 정방향만, 내부는 전체(반납 입고확인 포함). 회수·반납은 회수 관리에서 처리 */}
                      {s.status === "출고완료" && (caps.operate || (caps.confirmOwn && !isReturn(s))) && <button onClick={() => setStatus(s, "입고확인", "입고확인")} style={btnGhost}>입고확인</button>}
                      {s.status === "출고완료" && caps.confirmOwn && isReturn(s) && <span style={{ color: C.hint, fontSize: 11 }}>센터 확인 대기</span>}
                      {s.status === "입고확인" && <span style={{ color: C.green, fontSize: 11 }}>✓ 완료</span>}
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
      <Note>날짜 범위로 조회할 수 있어요. 출고처→입고처로 흐름이, 출고일시·입고확인 시각이 함께 보입니다. <b>⋯</b> 버튼으로 출고완료 건을 수정·취소할 수 있어요(이력 보존).</Note>
      {edit && <EditShipmentModal s={edit} palletTypes={palletTypes} onClose={() => setEdit(null)} onSave={editShipment} onCancel={cancelShipment} />}
      {slipBatch && <SlipPrint rows={ships.filter((s) => (s.batch_id || s.id) === slipBatch)} palletTypes={palletTypes} onClose={() => setSlipBatch(null)} />}
    </>
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
          <tr><td style={cellH}>발송처</td><td style={cell} colSpan={3}>{from}{h.operator_name ? ` · ${h.operator_name}` : ""}</td></tr>
          <tr><td style={cellH}>도착처</td><td style={cell} colSpan={3}>{to}</td></tr>
          <tr><td style={cellH}>차량/기사</td><td style={cell} colSpan={3}>{h.vehicle_no || ""}{h.vehicle_no ? " / " : ""}</td></tr>
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
            <td style={{ ...cell, height: 38, verticalAlign: "bottom", fontSize: 9, position: "relative" }}>{h.out_sign_url && <img src={h.out_sign_url} alt="" style={{ position: "absolute", top: 2, left: "50%", transform: "translateX(-50%)", height: 24 }} />}{h.operator_name || ""}</td>
            <td style={{ ...cell, height: 38, verticalAlign: "bottom" }}>(인)</td>
            <td style={{ ...cell, height: 38, verticalAlign: "bottom", fontSize: 9, position: "relative" }}>{h.in_sign_url && <img src={h.in_sign_url} alt="" style={{ position: "absolute", top: 2, left: "50%", transform: "translateX(-50%)", height: 24 }} />}{h.receiver_name || ""}</td>
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
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16, overflow: "auto" }}>
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
          @page { size: A4 landscape; margin: 6mm; }
          @media print {
            body * { visibility: hidden !important; }
            #slip-print, #slip-print * { visibility: visible !important; }
            #slip-print { position: absolute; left: 0; top: 0; width: 100%; display: flex !important; flex-wrap: nowrap !important; gap: 3mm !important; justify-content: space-between !important; }
            #slip-print .slip-copy { flex: 1 1 0 !important; width: auto !important; min-width: 0 !important; }
            .no-print { display: none !important; }
          }
        `}</style>
      </div>
    </div>
  );
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
function PalletQtyEditor({ palletTypes, qtys, setQtys, color = C.teal, bg = C.tealBg, maxOf, maxLabel = "보유" }) {
  const set = (code, v) => setQtys((q) => ({ ...q, [code]: v }));
  return (
    <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
      {palletTypes.map((p) => {
        const max = maxOf ? maxOf(p.code) : Infinity;
        const disabled = !!maxOf && max <= 0;
        const v = qtys[p.code] || 0;
        return (
          <div key={p.code} style={{ display: "flex", alignItems: "center", gap: 10, opacity: disabled ? 0.4 : 1 }}>
            <div style={{ width: 104, flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{p.code}</span>
              {maxOf && <span style={{ fontSize: 11, color: max <= 0 ? C.red : C.hint }}> · {maxLabel} {max}</span>}
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", border: `1px solid ${v > 0 ? color : C.border}`, borderRadius: 8, padding: "4px 12px", background: v > 0 ? bg : "#fff" }}>
              <button disabled={disabled} onClick={() => set(p.code, Math.max(0, v - 1))} style={{ background: "none", border: "none", fontSize: 20, color: C.sub, cursor: "pointer" }}>−</button>
              <input type="number" value={v} disabled={disabled} onChange={(e) => { let n = Math.max(0, parseInt(e.target.value) || 0); if (max !== Infinity) n = Math.min(n, max); set(p.code, n); }} style={{ width: 56, textAlign: "center", fontSize: 16, fontWeight: 600, border: "none", outline: "none", background: "transparent" }} />
              <button disabled={disabled || v >= max} onClick={() => set(p.code, Math.min(max, v + 1))} style={{ background: "none", border: "none", fontSize: 20, color, cursor: disabled || v >= max ? "default" : "pointer" }}>+</button>
            </div>
          </div>
        );
      })}
    </div>
  );
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
  const ref = useRef(null); const drawing = useRef(false);
  const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  const pos = (e) => { const c = ref.current; const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) }; };
  const start = (e) => { drawing.current = true; const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); setDirty(true); e.preventDefault(); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#111"; ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => { drawing.current = false; };
  const clear = () => { const c = ref.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); setDone(false); setDirty(false); onSave && onSave(null); };
  const apply = async () => {
    if (!dirty) return;
    setBusy(true);
    try { const blob = await new Promise((r) => ref.current.toBlob(r, "image/png")); const urls = await uploadPhotos([new File([blob], "sign.png", { type: "image/png" })]); onSave && onSave(urls[0]); setDone(true); }
    catch (e) { alert("서명 저장 실패: " + (e.message || e)); }
    setBusy(false);
  };
  return (
    <div>
      <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{label} {done && <span style={{ color, fontSize: 11, fontWeight: 600 }}>· 서명됨 ✓</span>}</div>
      <canvas ref={ref} width={280} height={90} onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ width: "100%", maxWidth: 280, height: 90, border: `1px solid ${done ? color : C.border}`, borderRadius: 8, touchAction: "none", background: "#fff", display: "block" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button type="button" onClick={apply} disabled={busy || !dirty} style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", background: (busy || !dirty) ? "#c7cad1" : color, color: "#fff" }}>{busy ? "저장 중…" : "서명 적용"}</button>
        <button type="button" onClick={clear} style={{ ...btnGhost, padding: "6px 12px" }}>지우기</button>
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

function Outbound({ partners, palletTypes, ships = [], ajReqs = [], centers = CENTERS, myCenters = CENTERS, onRegister, onTransfer, setNav }) {
  const today = new Date().toISOString().slice(0, 10);
  const [dir, setDir] = useState("출고");
  const [q, setQ] = useState(""); const [sel, setSel] = useState(null);
  const [qtys, setQtys] = useState({});
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(today); const [note, setNote] = useState(""); const [center, setCenter] = useState(myCenters[0] || centers[0]); const [toCenter, setToCenter] = useState(centers.find((c) => c !== (myCenters[0] || centers[0])) || centers[0]);
  const [photos, setPhotos] = useState([]); const [vehicleNo, setVehicleNo] = useState(""); const [slipRows, setSlipRows] = useState(null); const [outSign, setOutSign] = useState(null);
  const matches = partners.filter((p) => p.name.includes(q) || (p.type || "").includes(q)).slice(0, 6);
  const pick = (p) => { setSel(p); setQ(""); setOpen(false); };
  const isRet = dir === "반납"; const isMv = dir === "이동";
  const total = qtysTotal(qtys);
  const reset = () => { setQtys({}); setNote(""); setDate(today); setPhotos([]); setVehicleNo(""); setOutSign(null); };
  // 출고/이동은 출발 센터 재고 한도 내. 반납(거래처→센터)은 한도 없음.
  const stockOf = (code) => centerStock(ships, ajReqs, center, code);
  useEffect(() => { setQtys({}); }, [center, dir]);
  const themeColor = isRet ? C.amber : isMv ? "#5b3aa6" : C.teal;
  const themeBg = isRet ? C.amberBg : isMv ? "#efe8ff" : C.tealBg;
  const canSubmit = total > 0 && !busy && (isMv ? center !== toCenter : !!sel);
  const submit = async () => {
    setBusy(true);
    const rows = isMv ? await onTransfer(center, toCenter, qtysToLines(qtys), photos, vehicleNo, note)
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
          {[["출고", "출고"], ["반납", "반납"], ["이동", "센터이동"]].map(([v, label]) => (
            <button key={v} onClick={() => setDir(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: dir === v ? (v === "반납" ? C.amber : v === "이동" ? "#5b3aa6" : C.teal) : "transparent", color: dir === v ? "#fff" : C.sub }}>{label}</button>
          ))}
        </div>

        {isMv ? (
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
                <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="예: 쿠팡, 시공팀, 이케아…" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
                {open && (
                  <div style={{ position: "absolute", top: 44, left: 0, right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 5, maxHeight: 240, overflow: "auto" }}>
                    {matches.length === 0 && <div style={{ padding: "10px 12px", fontSize: 13, color: C.hint }}>일치하는 거래처 없음</div>}
                    {matches.map((p) => (
                      <button key={p.code} onClick={() => pick(p)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", border: "none", borderBottom: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", textAlign: "left" }}>
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

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형·수량 <span style={{ color: C.hint, fontSize: 11 }}>· {isRet ? "여러 종류 한 번에" : "센터 재고 한도 내"}</span></div>
        <PalletQtyEditor palletTypes={palletTypes} qtys={qtys} setQtys={setQtys} color={themeColor} bg={themeBg} maxOf={isRet ? undefined : stockOf} maxLabel="재고" />
        {total > 0 && <div style={{ fontSize: 12, color: C.sub, marginBottom: 14, textAlign: "right" }}>합계 <b style={{ color: C.text }}>{total}</b>장</div>}

        {!isMv && (
          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isRet ? "반납일자" : "출고일자"}</div>
              <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
            </div>
          </div>
        )}

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>차량번호</div>
        <input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="예: 12가 3456" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }} />

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>메모 <span style={{ color: C.hint, fontSize: 11 }}>· 선택</span></div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="기사명, 특이사항 등" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

        <div style={{ marginBottom: 18 }}><PhotoCapture photos={photos} setPhotos={setPhotos} label={isMv ? "센터이동 현장 사진" : isRet ? "반납 현장 사진" : "출고 현장 사진"} color={themeColor} /></div>

        {!isMv && <div style={{ marginBottom: 18 }}><SignaturePad onSave={setOutSign} label={isRet ? "반납자 서명" : "출고자 서명"} color={themeColor} /></div>}

        <button disabled={!canSubmit} onClick={submit} style={{ width: "100%", background: !canSubmit ? "#c7cad1" : themeColor, color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "처리 중…" : isRet ? "반납 등록" : isMv ? "센터 이동" : "출고 등록"}</button>
        <p style={{ textAlign: "center", fontSize: 11, color: C.hint, marginTop: 10 }}>{isRet ? "거래처가 우리에게 돌려준 파렛트를 기록해요" : isMv ? "센터 간 재고를 옮겨요 (출발 −, 도착 +)" : "등록 즉시 전표 자동 발행 · Supabase에 저장"}</p>
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

            <button disabled={total === 0 || busy} onClick={submit} style={{ width: "100%", background: (total === 0 || busy) ? "#c7cad1" : (isAj ? "#7a4ad8" : C.amber), color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "등록 중…" : isAj ? "AJ 회수요청" : "센터 반납 등록"}</button>
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
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><DirBadge s={s} />{fromOf(s)} → {toOf(s)}</div>
          <div style={{ fontSize: 12, color: C.sub }}>{s.slip_no} · {s.pallet_code} · {s.qty}장{s.note ? ` · ${s.note}` : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={() => setOpen((o) => !o)} style={{ ...btnGhost, color: (photos.length || sign) ? C.tealDk : C.sub }}>📷{photos.length ? ` ${photos.length}` : ""}{sign ? " ✍" : ""}</button>
          <button onClick={() => setStatus(s, "입고확인", "입고확인", photos, sign)} style={btnTeal}>✓ 입고확인</button>
        </div>
      </div>
      {open && <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: "grid", gap: 14 }}>
        <PhotoCapture photos={photos} setPhotos={setPhotos} label="입고 사진" hint="받은 파렛트 / 차량" />
        <SignaturePad onSave={setSign} label="인수자 서명" />
      </div>}
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
  const [center, setCenter] = useState(centers[0]);
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const total = qtysTotal(qtys);
  const pending = ajReqs.filter((r) => r.status === "요청");          // AJ직원 처리 대기
  const inbound = ajReqs.filter((r) => r.type === "공급" && r.status === "발송"); // 우리 센터 입고 대기
  const done = ajReqs.filter((r) => r.status === "완료").slice(0, 30);
  const isSupply = type === "공급";

  const submit = async () => {
    setBusy(true);
    const ok = await createAjRequest({ type, lines: qtysToLines(qtys), center, note });
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
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>{isSupply ? "공급 받는 센터" : "회수 보내는 센터"}</div>
          <select value={center} onChange={(e) => setCenter(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 16 }}>{centers.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형·수량</div>
          <PalletQtyEditor palletTypes={palletTypes} qtys={qtys} setQtys={setQtys} color={isSupply ? C.teal : C.amber} bg={isSupply ? C.tealBg : C.amberBg} />
          {total > 0 && <div style={{ fontSize: 12, color: C.sub, marginBottom: 12, textAlign: "right" }}>합계 <b style={{ color: C.text }}>{total}</b>장</div>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모(선택)" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 14, resize: "vertical", fontFamily: "inherit" }} />
          <button disabled={total === 0 || busy} onClick={submit} style={{ width: "100%", background: (total === 0 || busy) ? "#c7cad1" : (isSupply ? C.teal : C.amber), color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 15, cursor: "pointer" }}>{busy ? "접수 중…" : `${type}요청 접수`}</button>
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
                      <div style={{ fontSize: 11, color: C.hint, marginTop: 2 }}>{r.partner_name || r.center} · {fmtDT(r.requested_at)}</div>
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
      <Head title="거래처 · 단가" sub="거래처를 등록하면 출고 등록 검색에 바로 잡혀요" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>파렛트 유형 · 단가{caps.priceEdit && <span style={{ color: C.hint, fontWeight: 400, fontSize: 11 }}> · 단가 클릭해서 수정</span>}</h3>
          <table style={tbl}>
            <thead><tr><Th>유형</Th><Th>용도</Th><Th r>단가(원)</Th></tr></thead>
            <tbody>
              {palletTypes.map((p) => (
                <PriceRow key={p.code} p={p} price={prices[p.code] || 0} editable={!!caps.priceEdit} onSave={setPrice} />
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: C.hint, marginTop: 10 }}>모든 파렛트 유형은 거래처 구분 없이 어디로든 출고할 수 있어요.{caps.priceEdit && " 단가를 바꾸면 정산에 즉시 반영돼요."}</p>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>거래처 <span style={{ color: C.hint, fontWeight: 400 }}>({filtered.length}/{partners.length})</span></h3>
          <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="이름으로 검색…" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {["전체", "업체", "시공팀", "센터"].map((f) => {
              const on = pf === f;
              return <button key={f} onClick={() => setPf(f)} style={{ fontSize: 12, padding: "4px 11px", borderRadius: 20, cursor: "pointer", border: on ? "none" : `1px solid ${C.border}`, background: on ? C.teal : "#fff", color: on ? "#fff" : C.sub }}>{f}</button>;
            })}
          </div>
          <div style={{ maxHeight: 240, overflow: "auto", marginBottom: 12 }}>
            <table style={tbl}><tbody>
              {filtered.map((p) => { const locked = hasStock(p.code); return (
                <tr key={p.code} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{p.name}</Td>
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
    const { error } = await supabase.from("profiles").update({ name: name || null, company: company || null, phone: phone || null }).eq("id", session.user.id);
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
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>표시 이름</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }} />
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>연락처</div>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="휴대폰 번호" style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 11px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />
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
