// Limpieza total de caché + recarga con código fresco.
// (deploy 01-jul: fuerza build de pase-yndx para publicar recibos + botón.)
//
// Motivo (01-jul, Anto): tras un deploy, un navegador puede quedar sirviendo
// el bundle viejo (HTTP cache / SW / Cache Storage). Síntoma: cambios que YA
// están en producción "no aparecen" y features nuevas no funcionan aunque el
// deploy esté READY. `useVersionPolling` (versionCheck.ts) lo resuelve solo en
// ~2 min, pero cuando el usuario está apurado o algo quedó pegado, este botón
// da una salida manual e inmediata: desregistra el SW, borra Cache Storage,
// limpia el cache de perfil en sessionStorage y recarga pidiendo HTML nuevo
// (Vercel sirve index.html con no-cache → linkea los bundles con hash nuevo).
//
// NO borra todo localStorage a propósito: preserva tema, remember-me y
// preferencias del sidebar. Solo limpia lo que puede quedar stale del perfil.
export async function limpiarCacheYRecargar(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* seguir igual — el objetivo final es recargar */ }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* idem */ }
  try {
    sessionStorage.removeItem("pase_user");
    sessionStorage.removeItem("pase_local_activo");
  } catch { /* idem */ }
  // Recarga: Vercel sirve index.html con no-cache, así que esto trae el HTML
  // nuevo que referencia los bundles con hash nuevo.
  window.location.reload();
}
