import { useState } from "react";
import { db } from "../lib/supabase";
import type { Usuario } from "../types";

interface ForcePasswordChangeProps {
  user: Usuario;
  // onDone NO se usa en la versión nueva — siempre redirigimos al login
  // después del cambio para que el user entre con tokens frescos.
  // Se mantiene en la firma para compatibilidad con App.tsx que aún lo pasa.
  onDone?: () => void;
}

// Refactor 27-may iteración 3: después de 3 intentos fallidos de fixear
// el bug client-side ("se queda Guardando..."), pasamos TODA la lógica
// al endpoint serverless. Originalmente /api/auth-change-password, movido
// a /api/auth-admin?action=change_password_self el 26-jun para liberar
// cupo Vercel Hobby (fix audit CRIT-1 Stripe webhook).
//
// Por qué es definitivo:
// - Server-side hace ambos pasos (cambio pass + UPDATE flag) atómicamente
//   con service_key. Sin race conditions con USER_UPDATED event.
// - El endpoint valida el JWT con Admin API — no depende de que la session
//   client-side esté "fresca". Funciona incluso si los tokens fueron
//   revocados por un reset previo via Admin API.
// - Devuelve códigos UPPER_SNAKE que mapeamos a mensajes claros en español.
// - Después del éxito hacemos signOut() + redirect al login → el user
//   vuelve a autenticarse con la pass nueva → tokens frescos → no hay
//   forma de quedar con tokens revocados activos.
//
// Botón "Cerrar sesión" SIEMPRE visible — escape garantizado para el user
// si algo sale mal o si llegó acá por una session vieja revocada.

const ERROR_MESSAGES: Record<string, string> = {
  SAME_PASSWORD: "Tenés que poner una contraseña distinta a la actual. Si no te acordás, probá una nueva — la de antes puede haber quedado cambiada en un intento previo.",
  WEAK_PASSWORD: "Contraseña demasiado débil. Usá una más larga o combiná mayúsculas, números y símbolos.",
  PASSWORD_TOO_SHORT: "La contraseña es muy corta. Mínimo 8 caracteres.",
  JWT_INVALID: "Tu sesión venció. Apretá 'Cerrar sesión y volver al login' y entrá de nuevo.",
  NO_AUTH_HEADER: "Tu sesión no es válida. Apretá 'Cerrar sesión y volver al login'.",
  BAD_REQUEST: "Falta información. Refrescá la página y volvé a intentar.",
  MISSING_ENV: "Error de configuración del servidor. Avisanos.",
  UPDATE_FAILED: "No se pudo cambiar la contraseña. Intentá de nuevo en unos segundos.",
  FLAG_UPDATE_FAILED: "Tu contraseña se cambió pero quedó un paso pendiente. Volvé a entrar para que tome efecto.",
  METHOD_NOT_ALLOWED: "Error técnico. Refrescá la página.",
};

export default function ForcePasswordChange(_props: ForcePasswordChangeProps) {
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Limpia TODO el state local + signOut + redirige al login.
  // Es el botón de escape garantizado en esta pantalla.
  const cerrarSesion = async () => {
    setLoading(true);
    try { await db.auth.signOut(); } catch { /* no importa */ }
    try { sessionStorage.removeItem("pase_user"); } catch { /* no importa */ }
    try { sessionStorage.removeItem("pase_local_activo"); } catch { /* no importa */ }
    // No tocamos localStorage entero porque otras apps pueden usarlo, pero
    // el reload + signOut limpia los tokens de Supabase automáticamente.
    window.location.href = "/";
  };

  const submit = async () => {
    setErr("");
    if (newPass.length < 8) { setErr("Mínimo 8 caracteres"); return; }
    if (newPass !== confirm) { setErr("Las contraseñas no coinciden"); return; }
    setLoading(true);
    try {
      // Obtener el JWT actual para mandarlo al endpoint.
      const { data: { session } } = await db.auth.getSession();
      if (!session?.access_token) {
        setErr(ERROR_MESSAGES.JWT_INVALID || "Tu sesión venció.");
        return;
      }

      const resp = await fetch("/api/auth-admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: "change_password_self", newPassword: newPass }),
      });

      let data: { error?: string; detail?: string; ok?: boolean; passwordChanged?: boolean } = {};
      try { data = await resp.json(); } catch { /* no body */ }

      if (!resp.ok) {
        // eslint-disable-next-line no-console
        console.error("[ForcePasswordChange] endpoint error:", resp.status, data);
        const code = data.error || "";
        const msg = ERROR_MESSAGES[code] || data.detail || "No se pudo cambiar la contraseña. Intentá de nuevo.";
        setErr(msg);
        return;
      }

      // Éxito → signOut + redirect al login con flag ?changed=1 para
      // mostrar mensaje verde "contraseña cambiada, ingresá con la nueva".
      // Esto fuerza tokens frescos → no hay forma de quedar con session
      // revocada activa.
      try { await db.auth.signOut(); } catch { /* idem */ }
      try { sessionStorage.removeItem("pase_user"); } catch { /* idem */ }
      window.location.href = "/?changed=1";
    } catch (e: unknown) {
      // eslint-disable-next-line no-console
      console.error("[ForcePasswordChange] exception:", e);
      setErr("Error de red. Verificá tu conexión y volvé a intentar.");
    } finally {
      setLoading(false);
    }
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
        <button
          type="button"
          onClick={cerrarSesion}
          disabled={loading}
          style={{
            width:"100%", marginTop:10, padding:"10px",
            background:"transparent", border:"none",
            color:"var(--pase-text-muted)", fontSize:13, cursor:"pointer",
            textDecoration:"underline",
          }}
        >
          Cerrar sesión y volver al login
        </button>
      </div>
    </div>
  );
}
