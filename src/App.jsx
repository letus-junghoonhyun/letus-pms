import { useState, useEffect, useMemo, useCallback } from "react";
import * as XLSX from "xlsx";
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
const isUnrecovered = (s) => !isReturn(s) && (s.status === "출고완료" || s.status === "입고확인") && daysSince(s.depart_at) >= 7;
const DirBadge = ({ s }) => isReturn(s)
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

// ─── 역할 & 권한 ─────────────────────────────────────────────
const ROLES = ["관리자", "운송팀", "정산담당", "협력업체"];
const NAV_BY_ROLE = {
  관리자: ["현황", "출고", "확인", "회수", "정산", "마스터", "사용자"],
  운송팀: ["현황", "출고", "확인", "회수", "정산", "마스터"],
  정산담당: ["현황", "정산", "마스터"],
  협력업체: ["현황", "반납", "확인"],
};
// 역할별 능력치 (화면 가리기 + 버튼 잠금에 사용 / DB는 RLS가 별도로 막음)
const capsOf = (role) => ({
  outbound: ["관리자", "운송팀"].includes(role),   // 출고 등록(방향 선택 가능)
  operate: ["관리자", "운송팀"].includes(role),     // 회수요청·회수완료 등 내부 조치
  confirmOwn: role === "협력업체",                   // 본인 건 입고확인만
  returnReg: role === "협력업체",                    // 반납 출고 등록(거래처→우리)
  master: ["관리자", "운송팀"].includes(role),       // 거래처 등록·엑셀
  priceEdit: ["관리자", "정산담당"].includes(role),  // 단가 편집
  billing: ["관리자", "정산담당"].includes(role),    // 정산 확정
  users: role === "관리자",                          // 사용자 관리
});

// ─── 인증 화면 ───────────────────────────────────────────────
function Auth() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [company, setCompany] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setMsg("");
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) setMsg(error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: pw });
        if (error) { setMsg(error.message); }
        else {
          const u = data.user;
          if (u) {
            await supabase.from("profiles").upsert({ id: u.id, name: company || email.split("@")[0], email, company: company || null });
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
          {mode === "signup" && <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="회사명(거래처명)" style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }} />}
          <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="비밀번호" onKeyDown={(e) => e.key === "Enter" && submit()} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "11px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }} />
          {mode === "signup" && <div style={{ fontSize: 11, color: C.hint, marginBottom: 12, lineHeight: 1.5 }}>가입 후 관리자가 소속 거래처를 연결하면 본인 거래처 건이 보여요.</div>}
          {msg && <div style={{ fontSize: 12, color: C.red, background: C.redBg, padding: "8px 10px", borderRadius: 8, marginBottom: 12 }}>{msg}</div>}
          <button disabled={busy || !email || !pw} onClick={submit} style={{ width: "100%", background: busy ? "#c7cad1" : C.teal, color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 15, cursor: "pointer" }}>
            {busy ? "처리 중…" : mode === "login" ? "로그인" : "가입하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 메인 앱 ─────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!authReady) return <Splash text="불러오는 중…" />;
  if (!session) return <Auth />;
  return <Shell session={session} />;
}

const Splash = ({ text }) => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: C.sub, fontFamily: "system-ui, sans-serif", fontSize: 14 }}>{text}</div>
);

function Shell({ session }) {
  const [nav, setNav] = useState("현황");
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

  const loadAll = useCallback(async () => {
    setErr("");
    try {
      const [pt, up, pa, pp, sh, ur, me] = await Promise.all([
        supabase.from("pallet_type").select("*").order("code"),
        supabase.from("unit_price").select("*"),
        supabase.from("partner").select("*").eq("active", true).order("name"),
        supabase.from("partner_pallet").select("*"),
        supabase.from("shipment").select("*").order("depart_at", { ascending: false }),
        supabase.from("user_roles").select("role").eq("user_id", session.user.id).maybeSingle(),
        supabase.from("profiles").select("active").eq("id", session.user.id).maybeSingle(),
      ]);
      // 비활성 계정이면 차단 (active 컬럼 없으면 undefined → 통과)
      if (me?.data && me.data.active === false) { setBlocked(true); setLoading(false); return; }
      // 단가는 협력업체에게 RLS로 막혀 빈 값이 올 수 있어요 — 그건 에러가 아니므로 제외하고 검사
      const firstErr = [pt, pa, pp, sh].find((r) => r.error);
      if (firstErr) throw firstErr.error;
      setPalletTypes(pt.data || []);
      const pm = {}; (up.data || []).forEach((r) => { pm[r.pallet_code] = r.price; });
      setPrices(pm);
      setPartners(pa.data || []);
      const cm = {}; (pp.data || []).forEach((r) => { (cm[r.partner_code] = cm[r.partner_code] || []).push(r.pallet_code); });
      setContracted(cm);
      setShips((sh.data || []).filter((s) => !s.canceled)); // 취소건 제외 (canceled 컬럼 없으면 전부 통과)
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
      supabase.from("profiles").select("id, name, email, company, partner_code, active"),
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

  const register = async (partner, pallet, qty, departDate, note, direction = "출고") => {
    try {
      const { data: slip, error: e1 } = await supabase.rpc("next_slip_no");
      if (e1) throw e1;
      const id = uid();
      // departDate(YYYY-MM-DD)가 있으면 그 날짜로, 없으면 지금
      const depart_at = departDate ? new Date(departDate + "T09:00:00").toISOString() : new Date().toISOString();
      const { error: e2 } = await supabase.from("shipment").insert({
        id, slip_no: slip, to_partner: partner.code, to_partner_name: partner.name,
        pallet_code: pallet, qty, status: "출고완료", direction, depart_at, note: note || null, created_by: session.user.id,
      });
      if (e2) throw e2;
      await supabase.from("movement").insert({
        id: uid(), shipment_id: id, type: direction, direction, source: "앱", pallet_code: pallet, qty,
        to_partner: partner.code, to_partner_name: partner.name, created_by: session.user.id,
      });
      setFlash(slip); setNav("현황"); loadAll();
    } catch (e) { alert((direction === "반납" ? "반납" : "출고") + " 등록 실패: " + (e.message || e)); }
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

  const setStatus = async (s, newStatus, mvType) => {
    try {
      const { error } = await supabase.from("shipment").update({ status: newStatus }).eq("id", s.id);
      if (error) throw error;
      if (mvType) await supabase.from("movement").insert({
        id: uid(), shipment_id: s.id, type: mvType, source: "앱", pallet_code: s.pallet_code, qty: s.qty,
        to_partner: s.to_partner, to_partner_name: s.to_partner_name, created_by: session.user.id,
      });
      loadAll();
    } catch (e) { alert("상태 변경 실패: " + (e.message || e)); }
  };

  const addPartner = async (name, type) => {
    try {
      const code = "P" + Date.now().toString().slice(-7);
      const { error } = await supabase.from("partner").insert({ code, name, type });
      if (error) throw error;
      loadAll();
    } catch (e) { alert("거래처 등록 실패: " + (e.message || e)); }
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
    { key: "정산", label: "정산" }, { key: "마스터", label: "거래처·단가" },
    { key: "사용자", label: "사용자 관리" },
  ];
  const allowed = NAV_BY_ROLE[role] || ["현황"];
  const items = ALL_ITEMS.filter((it) => allowed.includes(it.key));
  const caps = capsOf(role);

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
          <div style={{ color: "#6b7494", fontSize: 11 }}>{session.user.email}</div>
          <div style={{ color: C.teal, fontSize: 11, marginBottom: 8 }}>{role}</div>
          <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 11, color: C.side, background: "transparent", border: "1px solid #3a4258", borderRadius: 6, padding: "5px 9px", cursor: "pointer" }}>로그아웃</button>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, padding: "20px 18px 80px", overflow: "auto" }}>
        {loading ? <Splash text="데이터 불러오는 중…" /> : err ? (
          <div style={{ background: C.redBg, color: C.red, padding: 16, borderRadius: 10, fontSize: 13 }}>
            {err}<br /><br />혹시 supabase.js에 anon key를 안 넣었거나, 쓰기 권한(RLS) 설정이 필요할 수 있어요. 화면을 캡처해서 Claude에게 물어보세요.
          </div>
        ) : (
          <>
            {nav === "현황" && <Dashboard {...{ ships, flash, setStatus, setNav, caps, palletTypes, editShipment, cancelShipment }} />}
            {nav === "출고" && caps.outbound && <Outbound partners={partnersFull} palletTypes={palletTypes} onRegister={register} />}
            {nav === "반납" && caps.returnReg && <ReturnRegister partners={partnersFull} palletTypes={palletTypes} onRegister={register} />}
            {nav === "확인" && <Confirm {...{ ships, setStatus, caps }} />}
            {nav === "회수" && caps.operate && <Recovery {...{ ships, setStatus }} />}
            {nav === "정산" && <Billing {...{ ships, prices, caps }} />}
            {nav === "마스터" && <Master {...{ palletTypes, prices, partners: partnersFull, addPartner, bulkAddPartners, caps, setPrice }} />}
            {nav === "사용자" && caps.users && <Users {...{ users, partners: partnersFull, setUserRole, setUserPartner, setUserActive, meId: session.user.id }} />}
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

function Dashboard({ ships, flash, setStatus, setNav, caps = {}, palletTypes = [], editShipment, cancelShipment }) {
  const [tab, setTab] = useState("전체");
  const [edit, setEdit] = useState(null);
  const tabs = ["전체", "출고완료", "입고확인", "회수요청", "미회수"];
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = ships.filter((s) => (s.depart_at || "").slice(0, 10) === todayStr).reduce((a, s) => a + s.qty, 0);
  const unrec = ships.filter(isUnrecovered).reduce((a, s) => a + s.qty, 0);
  const waiting = ships.filter((s) => s.status === "출고완료").length;
  const filtered = tab === "전체" ? ships : tab === "미회수" ? ships.filter(isUnrecovered) : ships.filter((s) => s.status === tab);

  return (
    <>
      <Head title="수불 현황" sub={new Date().toLocaleDateString("ko-KR")} action={caps.outbound ? <button onClick={() => setNav("출고")} style={btnTeal}>+ 출고 등록</button> : null} />
      {flash && <div style={{ background: C.greenBg, color: C.green, fontSize: 13, padding: "9px 14px", borderRadius: 8, marginBottom: 14 }}>✓ 출고 등록 완료 — 전표 {flash} 발행</div>}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Metric label="금일 출고" value={today} unit="장" tone="plain" />
        <Metric label="미회수 7일↑" value={unrec} unit="장" tone="danger" />
        <Metric label="입고확인 대기" value={waiting} unit="건" tone="warn" />
        <Metric label="총 건수" value={ships.length} unit="건" tone="plain" />
      </div>
      <Tabs tabs={tabs} tab={tab} setTab={setTab} count={(t) => t === "전체" ? ships.length : t === "미회수" ? ships.filter(isUnrecovered).length : ships.filter((s) => s.status === t).length} />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>방향</Th><Th>상태</Th><Th>전표</Th><Th>유형</Th><Th r>수량</Th><Th>거래처</Th><Th>경과</Th><Th>조치</Th></tr></thead>
          <tbody>
            {filtered.map((s) => {
              const danger = isUnrecovered(s); const d = daysSince(s.depart_at);
              return (
                <tr key={s.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td><DirBadge s={s} /></Td>
                  <Td><Pill status={danger ? "미회수" : s.status} /></Td>
                  <Td c={C.sub}>{s.slip_no}</Td><Td>{s.pallet_code}</Td><Td r>{s.qty}</Td><Td>{s.to_partner_name}</Td>
                  <Td c={danger ? C.red : s.status === "회수완료" ? C.hint : C.text} b={danger}>{s.status === "회수완료" ? "—" : d + "일"}</Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {/* 협력업체는 본인 건 입고확인만, 내부(운송/관리)는 전체 조치, 정산담당은 조회만 */}
                      {s.status === "출고완료" && (caps.operate || caps.confirmOwn) && <button onClick={() => setStatus(s, "입고확인", "입고확인")} style={btnGhost}>입고확인</button>}
                      {s.status === "입고확인" && caps.operate && <button onClick={() => setStatus(s, "회수요청", "회수요청")} style={btnGhost}>회수요청</button>}
                      {s.status === "회수요청" && caps.operate && <button onClick={() => setStatus(s, "회수완료", "회수")} style={btnTealSm}>회수완료</button>}
                      {s.status === "회수완료" && <span style={{ color: C.green }}>✓</span>}
                      {!caps.operate && !caps.confirmOwn && s.status !== "회수완료" && <span style={{ color: C.hint, fontSize: 11 }}>조회</span>}
                      {caps.operate && s.status === "출고완료" && <button onClick={() => setEdit(s)} style={{ ...btnGhost, color: C.sub }} title="수정·취소">⋯</button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>7일 이상 회수 안 된 건은 미회수(빨강)로 자동 분류돼요. 조치 버튼으로 상태가 흐르고 Supabase에 바로 저장됩니다. <b>⋯</b> 버튼으로 출고완료 건을 수정·취소할 수 있어요(이력 보존).</Note>
      {edit && <EditShipmentModal s={edit} palletTypes={palletTypes} onClose={() => setEdit(null)} onSave={editShipment} onCancel={cancelShipment} />}
    </>
  );
}

function EditShipmentModal({ s, palletTypes, onClose, onSave, onCancel }) {
  const [pallet, setPallet] = useState(s.pallet_code);
  const [qty, setQty] = useState(s.qty);
  const [date, setDate] = useState((s.depart_at || "").slice(0, 10));
  const [note, setNote] = useState(s.note || "");
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const save = async () => {
    setBusy(true);
    await onSave(s, { pallet_code: pallet, qty: Number(qty), depart_at: new Date(date + "T09:00:00").toISOString(), note: note || null });
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

function Outbound({ partners, palletTypes, onRegister }) {
  const today = new Date().toISOString().slice(0, 10);
  const [dir, setDir] = useState("출고");
  const [q, setQ] = useState(""); const [sel, setSel] = useState(null);
  const [pallet, setPallet] = useState(null); const [qty, setQty] = useState(20);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(today); const [note, setNote] = useState("");
  const matches = partners.filter((p) => p.name.includes(q) || (p.type || "").includes(q)).slice(0, 6);
  const pick = (p) => { setSel(p); setQ(""); setOpen(false); };
  const isRet = dir === "반납";

  return (
    <>
      <Head title="출고 등록" sub="방향을 고르고, 거래처·유형·수량 입력" />
      <div style={{ maxWidth: 480, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>방향</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 18, background: "#eef0f3", borderRadius: 10, padding: 4 }}>
          {[["출고", "출고 (우리→거래처)"], ["반납", "반납 (거래처→우리)"]].map(([v, label]) => (
            <button key={v} onClick={() => setDir(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: dir === v ? (v === "반납" ? C.amber : C.teal) : "transparent", color: dir === v ? "#fff" : C.sub }}>{label}</button>
          ))}
        </div>
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

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형 <span style={{ color: C.hint, fontSize: 11 }}>· 전체 유형 선택 가능</span></div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, minHeight: 44, flexWrap: "wrap" }}>
          {palletTypes.map((p) => {
            const on = pallet === p.code;
            return <button key={p.code} onClick={() => setPallet(p.code)} style={{ minWidth: 70, fontSize: 14, padding: "11px 14px", borderRadius: 8, cursor: "pointer", border: on ? `1px solid ${C.teal}` : `1px solid ${C.border}`, background: on ? C.tealBg : "#fff", color: on ? C.tealDk : C.text, fontWeight: on ? 600 : 400 }}>{p.code}</button>;
          })}
        </div>

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>수량</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 16px", marginBottom: 18 }}>
          <button onClick={() => setQty(Math.max(1, qty - 1))} style={{ background: "none", border: "none", fontSize: 22, color: C.sub, cursor: "pointer" }}>−</button>
          <input value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} type="number" style={{ width: 80, textAlign: "center", fontSize: 20, fontWeight: 600, border: "none", outline: "none", MozAppearance: "textfield" }} />
          <button onClick={() => setQty(qty + 1)} style={{ background: "none", border: "none", fontSize: 22, color: C.teal, cursor: "pointer" }}>+</button>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>출고일자</div>
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }} />
          </div>
        </div>

        <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>메모 <span style={{ color: C.hint, fontSize: 11 }}>· 선택</span></div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="차량번호, 기사명, 특이사항 등" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

        <button disabled={!sel || !pallet || busy} onClick={async () => { setBusy(true); await onRegister(sel, pallet, qty, date, note, dir); setBusy(false); setNote(""); setDate(today); }} style={{ width: "100%", background: (!sel || !pallet || busy) ? "#c7cad1" : (isRet ? C.amber : C.teal), color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "등록 중…" : isRet ? "반납 등록" : "출고 등록"}</button>
        <p style={{ textAlign: "center", fontSize: 11, color: C.hint, marginTop: 10 }}>{isRet ? "거래처가 우리에게 돌려준 파렛트를 기록해요" : "등록 즉시 전표 자동 발행 · Supabase에 저장"}</p>
      </div>
    </>
  );
}

// 협력업체용 반납 등록 — 본인 거래처 명의로 우리에게 돌려보내는 파렛트 기록
function ReturnRegister({ partners, palletTypes, onRegister }) {
  const today = new Date().toISOString().slice(0, 10);
  const me = partners[0]; // 협력업체는 RLS로 본인 거래처만 보임
  const [pallet, setPallet] = useState(null); const [qty, setQty] = useState(20);
  const [date, setDate] = useState(today); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <>
      <Head title="반납 등록" sub="우리(렌탈사)에게 돌려보내는 파렛트를 등록하세요" />
      <div style={{ maxWidth: 480, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        {!me ? (
          <div style={{ fontSize: 13, color: C.amber, background: C.amberBg, padding: "12px 14px", borderRadius: 8 }}>아직 소속 거래처가 연결되지 않았어요. 관리자에게 문의하세요.</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>반납 주체</div>
            <div style={{ border: `1px solid ${C.amber}`, background: C.amberBg, borderRadius: 8, padding: "10px 12px", marginBottom: 18, fontSize: 14, color: C.amber, fontWeight: 600 }}>{me.name} → 렌탈사(우리)</div>

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>파렛트 유형</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
              {palletTypes.map((p) => { const on = pallet === p.code; return <button key={p.code} onClick={() => setPallet(p.code)} style={{ minWidth: 70, fontSize: 14, padding: "11px 14px", borderRadius: 8, cursor: "pointer", border: on ? `1px solid ${C.amber}` : `1px solid ${C.border}`, background: on ? C.amberBg : "#fff", color: on ? C.amber : C.text, fontWeight: on ? 600 : 400 }}>{p.code}</button>; })}
            </div>

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>수량</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 16px", marginBottom: 18 }}>
              <button onClick={() => setQty(Math.max(1, qty - 1))} style={{ background: "none", border: "none", fontSize: 22, color: C.sub, cursor: "pointer" }}>−</button>
              <input value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} type="number" style={{ width: 80, textAlign: "center", fontSize: 20, fontWeight: 600, border: "none", outline: "none" }} />
              <button onClick={() => setQty(qty + 1)} style={{ background: "none", border: "none", fontSize: 22, color: C.amber, cursor: "pointer" }}>+</button>
            </div>

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>반납일자</div>
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18 }} />

            <div style={{ fontSize: 13, color: C.sub, marginBottom: 7 }}>메모 <span style={{ color: C.hint, fontSize: 11 }}>· 선택</span></div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="차량번호, 특이사항 등" rows={2} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 18, resize: "vertical", fontFamily: "inherit" }} />

            <button disabled={!pallet || busy} onClick={async () => { setBusy(true); await onRegister(me, pallet, qty, date, note, "반납"); setBusy(false); setNote(""); setDate(today); setPallet(null); }} style={{ width: "100%", background: (!pallet || busy) ? "#c7cad1" : C.amber, color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 15, cursor: "pointer" }}>{busy ? "등록 중…" : "반납 등록"}</button>
            <p style={{ textAlign: "center", fontSize: 11, color: C.hint, marginTop: 10 }}>등록하면 우리쪽에서 입고확인 후 수불이 정리돼요</p>
          </>
        )}
      </div>
    </>
  );
}

function Confirm({ ships, setStatus, caps = {} }) {
  // 협력업체: 우리가 보낸(정방향 출고)을 받았다고 확인 / 내부: 거래처가 보낸(반납)을 우리가 받았다고 확인
  const pending = ships.filter((s) => s.status === "출고완료" && (caps.confirmOwn ? !isReturn(s) : true));
  const sub = caps.confirmOwn ? "우리쪽에서 보낸 파렛트를 받으셨으면 확인하세요" : "거래처가 반납한 파렛트 등 입고를 확인하세요";
  return (
    <>
      <Head title="입고확인" sub={sub} />
      {pending.length === 0 ? <div style={{ padding: 40, textAlign: "center", color: C.hint, fontSize: 13 }}>확인 대기 중인 건이 없어요.</div> : (
        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          {pending.map((s) => (
            <div key={s.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><DirBadge s={s} />{s.to_partner_name}</div>
                <div style={{ fontSize: 12, color: C.sub }}>{s.slip_no} · {s.pallet_code} · {s.qty}장{s.note ? ` · ${s.note}` : ""}</div>
              </div>
              <button onClick={() => setStatus(s, "입고확인", "입고확인")} style={btnTeal}>✓ 입고확인</button>
            </div>
          ))}
        </div>
      )}
      <Note>{caps.confirmOwn ? "확인하면 우리 장부에 즉시 반영돼요." : "반납 입고확인을 누르면 그 수량만큼 해당 거래처 수불(미회수)이 정리돼요."}</Note>
    </>
  );
}

function Recovery({ ships, setStatus }) {
  const list = ships.filter((s) => s.status === "입고확인" || s.status === "회수요청");
  const total = list.reduce((a, s) => a + s.qty, 0);
  const over7 = ships.filter((s) => s.status === "입고확인" && daysSince(s.depart_at) >= 7).reduce((a, s) => a + s.qty, 0);
  const over14 = ships.filter((s) => s.status === "입고확인" && daysSince(s.depart_at) >= 14).reduce((a, s) => a + s.qty, 0);
  const inProg = ships.filter((s) => s.status === "회수요청").length;
  return (
    <>
      <Head title="회수 관리" sub="입고 완료 후 회수 대상 · 경과일 기준" />
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Metric label="회수 대상" value={total} unit="장" tone="plain" />
        <Metric label="7일↑" value={over7} unit="장" tone="warn" />
        <Metric label="14일↑ 위험" value={over14} unit="장" tone="danger" />
        <Metric label="회수요청 진행중" value={inProg} unit="건" tone="plain" />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>거래처</Th><Th>유형·수량</Th><Th>경과</Th><Th>조치</Th></tr></thead>
          <tbody>
            {list.map((s) => {
              const d = daysSince(s.depart_at); const danger = d >= 14;
              return (
                <tr key={s.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{s.to_partner_name}</Td><Td>{s.pallet_code} · {s.qty}</Td>
                  <Td c={danger ? C.red : d >= 7 ? C.amber : C.text} b={d >= 7}>{d}일</Td>
                  <Td>{s.status === "입고확인" ? <button onClick={() => setStatus(s, "회수요청", "회수요청")} style={btnTealSm}>회수요청</button> : <span style={{ fontSize: 11, padding: "3px 9px", borderRadius: 7, background: C.amberBg, color: C.amber }}>요청완료</span>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>14일↑은 위험(빨강)으로 분류돼요. 회수요청을 누르면 상태가 바뀌고 Supabase에 저장됩니다.</Note>
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

function Master({ palletTypes, prices, partners, addPartner, bulkAddPartners, caps = {}, setPrice }) {
  const [name, setName] = useState(""); const [type, setType] = useState("업체");
  const [pq, setPq] = useState(""); const [pf, setPf] = useState("전체");
  const [preview, setPreview] = useState([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const filtered = partners.filter((p) => (pf === "전체" || p.type === pf) && (p.name.includes(pq) || pq === ""));

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
              {filtered.map((p) => (
                <tr key={p.code} style={{ borderTop: `1px solid ${C.border}` }}>
                  <Td>{p.name}</Td>
                  <Td><TypeBadge t={p.type} /></Td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={2} style={{ padding: "16px 6px", fontSize: 12, color: C.hint, textAlign: "center" }}>검색 결과 없음</td></tr>}
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
      </div>
      <Note>거래처가 많아져도 검색·구분 필터로 빠르게 찾을 수 있어요. 나중에 엑셀 일괄 등록도 붙일 수 있어요.</Note>
    </>
  );
}

const ROLE_BADGE = {
  관리자: { bg: C.redBg, fg: C.red }, 운송팀: { bg: C.tealBg, fg: C.tealDk },
  정산담당: { bg: C.blueBg, fg: C.blue }, 협력업체: { bg: "#eef0f3", fg: C.sub },
};
function Users({ users, partners, setUserRole, setUserPartner, setUserActive, meId }) {
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
          <thead><tr><Th>사용자</Th><Th>역할</Th><Th>소속 거래처 (협력업체)</Th><Th>계정</Th></tr></thead>
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
                      <select value={u.partner_code || ""} onChange={(e) => setUserPartner(u.id, e.target.value || null)}
                        style={{ fontSize: 12, padding: "5px 8px", borderRadius: 7, border: `1px solid ${u.partner_code ? C.border : C.amber}`, maxWidth: 220 }}>
                        <option value="">(미지정 — 아무 것도 안 보임)</option>
                        {partners.map((p) => <option key={p.code} value={p.code}>{p.name} · {p.type}</option>)}
                      </select>
                    ) : <span style={{ fontSize: 12, color: C.hint }}>—</span>}
                  </Td>
                  <Td>
                    {me ? <span style={{ fontSize: 11, color: C.hint }}>—</span> : (
                      <button onClick={() => setUserActive(u.id, !u.active)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", border: `1px solid ${u.active ? C.border : C.red}`, background: u.active ? "#fff" : C.redBg, color: u.active ? C.sub : C.red }}>
                        {u.active ? "활성 · 비활성화" : "비활성 · 활성화"}
                      </button>
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
