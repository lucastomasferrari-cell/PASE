import { useState, useRef } from "react";
import { db } from "../lib/supabase";

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
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Usuario</label><input autoComplete="username" value={usuario} onChange={e=>setUsuario(e.target.value)} placeholder="Ingresá tu usuario" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <div className="field"><label>Contraseña</label><input ref={passRef} type="password" autoComplete="current-password" defaultValue="" placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={go} disabled={loading}>{loading?"Verificando...":"Ingresar"}</button>
      </div>
    </div>
  );
}
