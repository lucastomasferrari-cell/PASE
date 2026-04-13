import { useState } from "react";
import { db } from "../lib/supabase";

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export default function Login({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const go = async () => {
    if (!usuario || !password) return;
    setLoading(true); setErr("");
    const { data } = await db.from("usuarios").select("*").eq("email", usuario).eq("password", password).single();
    setLoading(false);
    if (data) onLogin(data); else setErr("Usuario o contraseña incorrectos");
  };
  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">GASTRO</div>
        <div className="login-sub">Sistema de Gestión</div>
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Usuario</label><input autoComplete="username" value={usuario} onChange={e=>setUsuario(e.target.value)} placeholder="dueno / admin / compras / cajero" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <div className="field"><label>Contraseña</label><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={go} disabled={loading}>{loading?"Verificando...":"Ingresar"}</button>
        <div style={{marginTop:16,padding:10,background:"var(--bg)",borderRadius:"var(--r)",fontSize:10,color:"var(--muted)",lineHeight:1.8}}>
          dueno123 · admin123 · compras123 · cajero123
        </div>
      </div>
    </div>
  );
}
