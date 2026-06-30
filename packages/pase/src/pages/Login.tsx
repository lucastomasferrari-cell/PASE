import { useState, useRef, useEffect, type CSSProperties } from "react";
import { db } from "../lib/supabase";
import type { UsuarioRow } from "../types";

interface LoginProps {
  onLogin: (u: UsuarioRow) => void;
}

// Flag persistido por el checkbox "Mantener sesión abierta".
const REMEMBER_ME_KEY = "pase_remember_me";

// ── Paleta del login unificado del ecosistema Cocina ────────────────────────
// Mismo patrón visual en PASE / COMANDA / MESA / Habitué: celeste PASE,
// tamaños/márgenes/tipografía idénticos, toggle dark/light. PASE no usa
// Tailwind → estilos inline con los mismos valores hex que el LoginCard de
// las otras apps. El tema usa el mecanismo propio de PASE (data-theme +
// localStorage 'pase-theme') para que el resto de la app quede en sintonía.
const PAL = {
  light: {
    pageBg: "#EFF3F8", cardBg: "#FFFFFF", cardBorder: "#E0EAF4",
    text: "#1A3A5E", muted: "#6E8CAB", inputBg: "#FFFFFF",
    inputBorder: "#D0DCEA", placeholder: "#9DB2CC", toggleHover: "#EAF3FB",
  },
  dark: {
    pageBg: "#0C1220", cardBg: "#1A2540", cardBorder: "#2A3550",
    text: "#F0F4F8", muted: "#93A8C2", inputBg: "#0C1220",
    inputBorder: "#3F4D6E", placeholder: "#6E8CAB", toggleHover: "#1E3155",
  },
};
const CELESTE = "#75AADB";
const GOLD = "#F5C518";

function readDark(): boolean {
  try {
    const t = localStorage.getItem("pase-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
  } catch { /* idem */ }
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark") return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export default function Login({ onLogin }: LoginProps) {
  const [usuario, setUsuario] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [dark, setDark] = useState<boolean>(readDark);
  const [recordarme, setRecordarme] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(REMEMBER_ME_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, recordarme ? "true" : "false");
    } catch { /* idem */ }
  }, [recordarme]);

  // Aplicar el tema al documento (el resto de PASE lee data-theme/pase-theme).
  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      localStorage.setItem("pase-theme", dark ? "dark" : "light");
    } catch { /* idem */ }
  }, [dark]);

  const c = dark ? PAL.dark : PAL.light;

  const cambioOk = typeof window !== "undefined" && window.location.search.includes("changed=1");

  const go = async () => {
    const password = passRef.current?.value || "";
    if (!usuario || !password) return;
    setLoading(true); setErr("");

    const authEmail = usuario.includes("@") ? usuario : usuario + "@pase.local";
    const { data: authData, error: authErr } = await db.auth.signInWithPassword({
      email: authEmail,
      password,
    });

    if (authErr || !authData?.user) {
      setLoading(false);
      setErr("Usuario o contraseña incorrectos");
      return;
    }

    const { data: usr, error: usrErr } = await db
      .from("usuarios")
      .select("*")
      .eq("auth_id", authData.user.id)
      .single();

    if (usrErr || !usr || !usr.activo) {
      await db.auth.signOut();
      setLoading(false);
      setErr("Usuario no encontrado o desactivado");
      return;
    }

    setLoading(false);
    onLogin(usr);
  };

  const labelStyle: CSSProperties = {
    display: "block", fontSize: 14, fontWeight: 500, color: c.text, marginBottom: 6,
  };
  const inputStyle: CSSProperties = {
    width: "100%", height: 44, borderRadius: 8,
    border: `1px solid ${c.inputBorder}`, background: c.inputBg,
    padding: "0 14px", fontSize: 14, color: c.text, outline: "none",
    transition: "border-color .15s, box-shadow .15s",
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = CELESTE;
    e.currentTarget.style.boxShadow = `0 0 0 3px ${CELESTE}40`;
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = c.inputBorder;
    e.currentTarget.style.boxShadow = "none";
  };

  return (
    <div style={{
      minHeight: "100vh", display: "grid", placeItems: "center",
      padding: 16, background: c.pageBg,
    }}>
      <div style={{
        position: "relative", width: "100%", maxWidth: 400, padding: 32,
        borderRadius: 16, background: c.cardBg, border: `1px solid ${c.cardBorder}`,
        boxShadow: "0 2px 4px rgba(26,58,94,0.04), 0 4px 16px rgba(26,58,94,0.08)",
      }}>
        <button
          type="button"
          onClick={() => setDark((d) => !d)}
          aria-label={dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
          style={{
            position: "absolute", top: 16, right: 16, width: 32, height: 32,
            display: "grid", placeItems: "center", borderRadius: 8,
            border: "none", background: "transparent", color: c.muted, cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = c.toggleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {dark ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          )}
        </button>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 26, lineHeight: 1, fontWeight: 500, letterSpacing: "-0.02em", color: c.text }}>
            pase<span style={{ color: GOLD }}>.</span>
          </div>
          <p style={{ marginTop: 8, fontSize: 12, color: c.muted }}>
            Back-office gastronómico — el sistema de tu local.
          </p>
        </div>

        {cambioOk && !err && (
          <div style={{
            background: dark ? "#1E3155" : "#EAF3FB", border: `1px solid ${c.cardBorder}`,
            color: c.text, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16,
          }}>
            Contraseña cambiada. Ingresá con la nueva.
          </div>
        )}
        {err && (
          <div style={{
            background: dark ? "#3A1A1A" : "#FDECEC", border: "1px solid #F5C2C2",
            color: "#C0392B", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16,
          }}>{err}</div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Usuario</label>
          <input autoComplete="username" value={usuario} onChange={(e) => setUsuario(e.target.value)}
            placeholder="Ingresá tu usuario" onKeyDown={(e) => e.key === "Enter" && go()}
            style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Contraseña</label>
          <input ref={passRef} type="password" autoComplete="current-password" defaultValue=""
            placeholder="••••••••" onKeyDown={(e) => e.key === "Enter" && go()}
            style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
        </div>

        <label style={{
          display: "flex", alignItems: "center", gap: 8, margin: "0 0 18px",
          cursor: "pointer", fontSize: 13, color: c.muted, userSelect: "none",
        }}>
          <input type="checkbox" checked={recordarme} onChange={(e) => setRecordarme(e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer", accentColor: CELESTE }} />
          Mantener sesión abierta
        </label>

        <button onClick={go} disabled={loading} style={{
          width: "100%", height: 44, borderRadius: 8, border: "none",
          background: CELESTE, color: "#fff", fontSize: 14, fontWeight: 500,
          cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
          transition: "background .15s",
        }}>
          {loading ? "Verificando…" : "Ingresar"}
        </button>
      </div>
    </div>
  );
}
