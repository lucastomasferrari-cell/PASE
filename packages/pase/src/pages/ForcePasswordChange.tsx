import { useState } from "react";
import { db } from "../lib/supabase";
import type { Usuario } from "../types";

interface ForcePasswordChangeProps {
  user: Usuario;
  onDone: () => void;
}

// Bug 27-may (Lucas): cuando un tenant nuevo creaba su 1er usuario, este
// quedaba colgado con "Guardando..." al cambiar la contraseña. Causa raíz:
// el UPDATE directo `db.from("usuarios").update({password_temporal:false})`
// se ejecutaba JUSTO después de `auth.updateUser`, que dispara el evento
// USER_UPDATED. El listener en App.tsx hace re-fetch del perfil → puede
// quedar racing con el UPDATE. En el peor caso, la promise del UPDATE no
// resolvía. Evidencia: Malita (id=43) logueó OK 2026-05-20 pero
// password_temporal siguió en true → el UPDATE nunca pasó.
//
// Fix: usar RPC SECURITY DEFINER `fn_marcar_password_cambiada()` que
// bypassa RLS y resuelve rápido. + timeout de 12s en `auth.updateUser`
// (no debería tardar más de 2s en condiciones normales). + try/catch
// alrededor de todo para que un throw inesperado no deje el botón
// disabled para siempre.

const AUTH_UPDATE_TIMEOUT_MS = 12_000;

// Traducción de códigos comunes de Supabase Auth al español.
// `same_password` es el caso que más confundía en producción: el flow
// se cuelga sin explicación cuando el user tipea la misma contraseña que ya
// tiene (típicamente porque el cambio anterior funcionó pero quedó el flag
// password_temporal=true por un race condition pre-fix).
// Detecta si el error es "sesión perdida" — pasa cuando los tokens del
// browser fueron revocados (típicamente porque un admin reseteó el password
// vía Admin API, o porque pasó mucho tiempo y el refresh token venció).
// En ese caso, NO hay forma de recuperar desde la pantalla: hay que volver
// al login con la pass nueva.
function isSessionError(err: { code?: string; message?: string; name?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "session_not_found" || err.code === "invalid_credentials") return true;
  if (err.name === "AuthSessionMissingError") return true;
  if ((err.message || "").toLowerCase().includes("session missing")) return true;
  return false;
}

function translateAuthError(err: { code?: string; message?: string; name?: string } | null): string {
  if (!err) return "Error desconocido";
  if (isSessionError(err)) {
    return "Tu sesión venció. Apretá el botón de abajo para volver al login y entrar de nuevo con tu contraseña.";
  }
  const code = err.code || "";
  switch (code) {
    case "same_password":
      return "Tenés que poner una contraseña distinta a la actual. Si no te acordás, probá una nueva — la de antes ya quedó cambiada en un intento previo.";
    case "weak_password":
      return "Contraseña demasiado débil. Usá una más larga o combiná mayúsculas, números y símbolos.";
    case "password_too_short":
      return "La contraseña es muy corta. Mínimo 8 caracteres.";
    default:
      return err.message || "No se pudo cambiar la contraseña";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT_${label}`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

export default function ForcePasswordChange({ user, onDone }: ForcePasswordChangeProps) {
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  // Se setea TRUE cuando el error es de sesión perdida → muestra botón
  // "Volver al login" en lugar de seguir intentando.
  const [sessionLost, setSessionLost] = useState(false);

  // Cierra sesión y recarga — única vía limpia cuando los tokens fueron
  // revocados. Después del reload el user cae al Login y entra de nuevo.
  const volverAlLogin = async () => {
    try { await db.auth.signOut(); } catch { /* ignoramos */ }
    try { sessionStorage.removeItem("pase_user"); } catch { /* ignoramos */ }
    window.location.reload();
  };

  const submit = async () => {
    setErr("");
    if (newPass.length < 8) { setErr("Mínimo 8 caracteres"); return; }
    if (newPass !== confirm) { setErr("Las contraseñas no coinciden"); return; }
    setLoading(true);
    try {
      // Paso 1 — Cambiar password en Supabase Auth. Es la operación lenta;
      // ponemos timeout defensivo para no quedarnos cargando para siempre.
      // Promise.resolve(thenable) lo convierte en Promise real — algunas
      // builders de supabase-js no exponen catch/finally, así que withTimeout
      // no las acepta directo.
      const { error: authErr } = await withTimeout(
        Promise.resolve(db.auth.updateUser({ password: newPass })),
        AUTH_UPDATE_TIMEOUT_MS,
        "AUTH_UPDATE",
      );
      if (authErr) {
        // Loguear el error completo en consola para debug — la pantalla
        // muestra solo el mensaje traducido.
        // eslint-disable-next-line no-console
        console.error("[ForcePasswordChange] auth.updateUser error:", authErr);
        if (isSessionError(authErr)) setSessionLost(true);
        setErr(translateAuthError(authErr));
        return;
      }

      // Paso 2 — Marcar password_temporal=false vía RPC SECURITY DEFINER.
      // Usamos RPC en lugar de UPDATE directo para evitar el cuelgue del
      // bug 27-may. La RPC chequea auth.uid() internamente — siempre
      // actualiza la fila correcta del user logueado.
      const { error: rpcErr } = await withTimeout(
        Promise.resolve(db.rpc("fn_marcar_password_cambiada")),
        AUTH_UPDATE_TIMEOUT_MS,
        "RPC_MARCAR",
      );
      if (rpcErr) {
        // Si el RPC falla, el password EN Supabase Auth ya cambió pero
        // la flag local quedó en true. La próxima vez que loguee le va a
        // volver a aparecer la pantalla. Mejor avisar.
        setErr(
          "Tu contraseña se actualizó pero quedó pendiente un paso. " +
          "Refrescá la página e ingresá de nuevo. Si persiste, " +
          "escribinos. (" + rpcErr.message + ")",
        );
        return;
      }

      // Éxito completo → adelante.
      onDone();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("TIMEOUT_")) {
        setErr(
          "Tardó demasiado en responder. Refrescá la página e intentá de " +
          "nuevo. Si persiste, escribinos.",
        );
      } else {
        setErr("Error inesperado: " + msg);
      }
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
        {sessionLost ? (
          <button
            className="btn btn-acc"
            style={{width:"100%",justifyContent:"center",marginTop:8}}
            onClick={volverAlLogin}
          >
            Volver al login
          </button>
        ) : (
          <>
            <div className="field"><label>Nueva contraseña</label><input type="password" autoComplete="new-password" value={newPass} onChange={e=>setNewPass(e.target.value)} placeholder="mínimo 8 caracteres" /></div>
            <div className="field"><label>Confirmar</label><input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="repetí la contraseña" onKeyDown={e=>e.key==="Enter"&&submit()} /></div>
            <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={submit} disabled={loading}>{loading?"Guardando...":"Guardar y continuar"}</button>
          </>
        )}
      </div>
    </div>
  );
}
