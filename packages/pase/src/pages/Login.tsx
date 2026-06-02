import { useState, useRef, useEffect } from "react";
import { db } from "../lib/supabase";
import type { UsuarioRow } from "../types";

interface LoginProps {
  onLogin: (u: UsuarioRow) => void;
}

// Flag persistido por el checkbox "Mantener sesión abierta".
// versionCheck.ts lo lee post-deploy: si está en true, hace solo reload
// (sin signOut). Si está en false, mantiene comportamiento legacy.
const REMEMBER_ME_KEY = "pase_remember_me";

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export default function Login({ onLogin }: LoginProps) {
  const [usuario, setUsuario] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  // Recordar la sesión entre deploys. Default ON — es lo que el user espera
  // por costumbre. Si tildás OFF, te desloguea automático cada deploy.
  const [recordarme, setRecordarme] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(REMEMBER_ME_KEY);
      // Default ON la primera vez (sin valor explícito); respetar elección si ya hay valor
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const passRef = useRef<HTMLInputElement>(null);

  // Persistir el toggle al cambiarlo (UX: se aplica YA, no espera al login)
  useEffect(() => {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, recordarme ? "true" : "false");
    } catch { /* idem */ }
  }, [recordarme]);

  // Mensaje "contraseña cambiada OK" cuando el user viene del flow de
  // ForcePasswordChange exitoso (redirige a /?changed=1).
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

  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">PASE</div>
        <div className="login-sub">aliado gastronómico</div>
        {cambioOk && !err && (
          <div className="alert" style={{
            background: "rgba(43,182,115,0.12)",
            border: "1px solid rgba(43,182,115,0.3)",
            color: "#2BB673",
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 14,
            marginBottom: 14,
          }}>
            ✓ Contraseña cambiada. Ingresá con la nueva.
          </div>
        )}
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Usuario</label><input autoComplete="username" value={usuario} onChange={e=>setUsuario(e.target.value)} placeholder="Ingresá tu usuario" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <div className="field"><label>Contraseña</label><input ref={passRef} type="password" autoComplete="current-password" defaultValue="" placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "10px 0 14px",
            cursor: "pointer",
            fontSize: 13,
            color: "var(--muted, #6b7280)",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={recordarme}
            onChange={(e) => setRecordarme(e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
          Mantener sesión abierta
        </label>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={go} disabled={loading}>{loading?"Verificando...":"Ingresar"}</button>
      </div>
    </div>
  );
}
