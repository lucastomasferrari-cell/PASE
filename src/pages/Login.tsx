import { useState, useRef } from "react";
import { db } from "../lib/supabase";

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export default function Login({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const passRef = useRef(null);

  const go = async () => {
    const password = passRef.current?.value || "";
    if (!usuario || !password) return;
    setLoading(true); setErr("");

    // Intentar Supabase Auth (email@pase.local)
    const authEmail = usuario.includes("@") ? usuario : usuario + "@pase.local";
    const { data: authData } = await db.auth.signInWithPassword({
      email: authEmail,
      password,
    });

    if (authData?.user) {
      const { data: perfil } = await db
        .from("usuarios")
        .select("*")
        .eq("auth_id", authData.user.id)
        .single();

      if (perfil) {
        setLoading(false);
        onLogin(perfil);
        return;
      }
    }

    // Fallback: comparar contra hash SHA-256
    const hash = await sha256(password);
    const { data } = await db
      .from("usuarios")
      .select("*")
      .eq("email", usuario)
      .eq("password", hash)
      .single();
    setLoading(false);

    if (data) onLogin(data);
    else setErr("Usuario o contraseña incorrectos");
  };

  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">GASTRO</div>
        <div className="login-sub">Sistema de Gestión</div>
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Usuario</label><input autoComplete="username" value={usuario} onChange={e=>setUsuario(e.target.value)} placeholder="Ingresá tu usuario" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <div className="field"><label>Contraseña</label><input ref={passRef} type="password" autoComplete="current-password" defaultValue="" placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={go} disabled={loading}>{loading?"Verificando...":"Ingresar"}</button>
      </div>
    </div>
  );
}
