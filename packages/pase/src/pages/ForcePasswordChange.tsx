import { useState } from "react";
import { db } from "../lib/supabase";

export default function ForcePasswordChange({ user, onDone }) {
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (newPass.length < 8) { setErr("Mínimo 8 caracteres"); return; }
    if (newPass !== confirm) { setErr("Las contraseñas no coinciden"); return; }
    setLoading(true);
    const { error: authErr } = await db.auth.updateUser({ password: newPass });
    if (authErr) { setLoading(false); setErr(authErr.message); return; }
    const { error: updErr } = await db
      .from("usuarios")
      .update({ password_temporal: false })
      .eq("id", user.id);
    if (updErr) { setLoading(false); setErr(updErr.message); return; }
    setLoading(false);
    onDone();
  };

  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">Cambiá tu contraseña</div>
        <div className="login-sub">Es la primera vez que ingresás. Definí una contraseña nueva para continuar.</div>
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Nueva contraseña</label><input type="password" autoComplete="new-password" value={newPass} onChange={e=>setNewPass(e.target.value)} placeholder="mínimo 8 caracteres" /></div>
        <div className="field"><label>Confirmar</label><input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="repetí la contraseña" onKeyDown={e=>e.key==="Enter"&&submit()} /></div>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={submit} disabled={loading}>{loading?"Guardando...":"Guardar y continuar"}</button>
      </div>
    </div>
  );
}
