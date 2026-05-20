// Detección + auto-recovery del error "Failed to fetch dynamically imported
// module" que aparece después de un deploy nuevo de Vercel.
//
// Por qué pasa:
//   1. El user tiene la app cargada con index.html viejo en memoria.
//   2. Pusheamos un deploy nuevo → los chunks viejos (Caja-BHGB-SZX.js) se
//      reemplazan por nuevos (Caja-XYZ123.js) en el bucket de Vercel.
//   3. El user navega a una nueva pantalla → React Router hace lazy import
//      apuntando al chunk viejo → 404 → "Failed to fetch dynamically
//      imported module".
//
// Solución: listener global a `unhandledrejection` + `error` que captura
// el rejection ANTES de que React intente renderizar el fallback. Cuando
// detectamos ese error específico, recargamos la página con anti-loop
// via flag en sessionStorage (max 1 reload por minuto).
//
// Decisión 2026-05-20: NO usar un wrapper custom sobre React.lazy()
// (lazyWithReload). El wrapper introducía un re-render extra que causaba
// inconsistencia de hooks en pantallas grandes (React error #310 en
// /equipo). El listener global es suficiente y menos invasivo.

const RELOAD_KEY = 'pase_chunk_reload_attempt';
const RELOAD_COOLDOWN_MS = 60_000; // 1 minuto

/**
 * Detecta si un error es de "dynamic import failed". Cobertura cross-browser:
 *   - Chrome/Edge: "Failed to fetch dynamically imported module"
 *   - Firefox:     "error loading dynamically imported module"
 *   - Safari:      "Importing a module script failed"
 *   - Algunos bundlers tiran "ChunkLoadError" como name.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { message?: string; name?: string };
  const msg = (e.message || '').toLowerCase();
  const name = (e.name || '').toLowerCase();
  return (
    name === 'chunkloaderror' ||
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    // Cuando el chunk responde 404 pero el browser lo reporta como network err
    (msg.includes('module') && msg.includes('failed'))
  );
}

/**
 * Intenta auto-reload si el error es de chunk loading. Devuelve `true` si
 * recargó (o programó la recarga), `false` si no debe recargar (cooldown o
 * no es el error específico).
 *
 * Antiloop: usa sessionStorage para no recargar más de 1 vez por minuto. Si
 * después del reload el error persiste, el ErrorBoundary muestra UI normal.
 */
export function tryReloadOnChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;

  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  const now = Date.now();
  if (now - last < RELOAD_COOLDOWN_MS) {
    // Ya recargamos hace poco — no entrar en loop.
    return false;
  }

  console.warn('[chunkLoadHandler] Chunk load error detectado, recargando…', error);
  sessionStorage.setItem(RELOAD_KEY, String(now));
  // location.reload() pega al server otra vez, no usa caché para index.html
  // (vercel.json le mete no-cache al "/" y "/index.html").
  window.location.reload();
  return true;
}

/**
 * Instala listeners globales en `window` para capturar chunk load errors que
 * salen como unhandled promise rejections (cuando lazy() falla antes de
 * llegar al ErrorBoundary de React).
 *
 * Llamarlo una sola vez en main.tsx antes de createRoot.
 */
export function installChunkLoadErrorHandler(): void {
  // Promise rejection sin handler (lazy(() => import()) sin .catch).
  window.addEventListener('unhandledrejection', (event) => {
    if (tryReloadOnChunkError(event.reason)) {
      // Prevenir que el browser logee el error en consola (vamos a reload).
      event.preventDefault();
    }
  });

  // Errores sincrónicos.
  window.addEventListener('error', (event) => {
    if (tryReloadOnChunkError(event.error)) {
      event.preventDefault();
    }
  });
}
