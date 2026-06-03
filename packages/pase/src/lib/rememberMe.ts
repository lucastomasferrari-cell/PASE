// Helper compartido del flag "Mantener sesión abierta" (Lucas 02-jun).
//
// Lucas reporta 02-jun noche: tras tildar el checkbox, F5 SIGUE
// deslogueando. Causa: el flag solo se respetaba en `versionCheck.ts`
// (post-deploy). Pero `App.tsx::restore()` tiene 3 paths adicionales
// que disparan `signOut()` automático al bootstrappear la sesión:
//
//   1. `getUser()` rechaza tokens (hard auth fail: 401/403/expired/revoked)
//   2. `refreshSession()` falla y JWT sigue sin app_metadata.tenant_id
//   3. `perfil.activo === false` en la tabla `usuarios`
//
// Cualquiera de esos paths podía dispararse en F5 normal (sin deploy)
// → user expulsado aunque el checkbox estuviera tildado.
//
// Este helper unifica la decisión: "¿Debo respetar el flag y NO
// desloguear automáticamente?". Si retorna `true`, el caller debe
// SOLO loggear el motivo y dejar la sesión local intacta — las
// queries pueden fallar pero el user no es expulsado contra su
// elección explícita.
//
// El user sí puede desloguearse manual (botón "Cerrar sesión" de
// Layout) o destildar el checkbox (próximo F5 vuelve al comportamiento
// legacy). El logout manual NO consulta este helper.

const REMEMBER_ME_KEY = "pase_remember_me";

/**
 * Lee el flag `pase_remember_me` de localStorage.
 * Retorna `true` si el user pidió mantener la sesión activa.
 * Default `false` (sin flag) — comportamiento legacy.
 */
export function isRememberMeActive(): boolean {
  try {
    return localStorage.getItem(REMEMBER_ME_KEY) === "true";
  } catch {
    // localStorage puede tirar SecurityError en modo incognito ultra-strict.
    return false;
  }
}

/**
 * Llamar DESDE cualquier handler que considere disparar signOut
 * automático (no manual). Retorna `true` si el signOut DEBE saltearse
 * (el flag está activo). El caller solo debe loggear y continuar.
 *
 * Uso típico:
 *   if (skipAutoSignOut('JWT expirado')) return;  // user pidió quedarse
 *   await db.auth.signOut();
 *   // cleanup...
 */
export function skipAutoSignOut(motivo: string): boolean {
  if (isRememberMeActive()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rememberMe] auto signOut omitido (motivo="${motivo}"). ` +
      `El user tildó 'Mantener sesión abierta' — conservamos la sesión local. ` +
      `Para desloguear: botón "Cerrar sesión" o destildar el checkbox en login.`
    );
    return true;
  }
  return false;
}
