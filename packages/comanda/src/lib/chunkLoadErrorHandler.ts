// Detección + auto-recovery del error "Failed to fetch dynamically imported
// module" que aparece después de un deploy nuevo de Vercel.
//
// Por qué pasa:
//   1. El POS tiene la app cargada con index.html viejo en memoria (las
//      tablets/PCs de salón quedan abiertas días enteros sin recargar).
//   2. Pusheamos un deploy nuevo → los chunks viejos (SalonView-B01V5vHp.js)
//      se reemplazan por nuevos en el bucket de Vercel.
//   3. La app pide un chunk lazy → 404 (Vercel devuelve index.html, MIME
//      text/html) → "Failed to fetch dynamically imported module".
//
// COMANDA ya tenía auto-reload en el ErrorBoundary, pero los boundaries de
// React SOLO atrapan errores de render. Bug Lucas 2026-06-11: "Abrir mesa"
// quedó colgado en "Abriendo..." porque el import dinámico falló adentro de
// ventasService.abrirVenta() (click handler, async) → unhandled rejection
// que el boundary nunca vio. Estos listeners globales cubren ese camino.
//
// Port del módulo homónimo de packages/pase/src/lib/chunkLoadErrorHandler.ts
// (mismo diseño, decidido 2026-05-20 allá: listener global, NO wrapper sobre
// React.lazy — el wrapper causaba React error #310).

const RELOAD_KEY = 'comanda_chunk_reload_attempt';
const RELOAD_COOLDOWN_MS = 60_000; // 1 minuto

/**
 * Detecta si un error es de "dynamic import failed". Cobertura cross-browser:
 *   - Chrome/Edge: "Failed to fetch dynamically imported module"
 *   - Firefox:     "error loading dynamically imported module"
 *   - Safari:      "Importing a module script failed"
 *   - Webpack-style: name "ChunkLoadError" / "Loading chunk N failed"
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
    /loading (css )?chunk \d+ failed/.test(msg) ||
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
 * salen como unhandled promise rejections (imports dinámicos en services o
 * click handlers, donde ningún ErrorBoundary llega).
 *
 * Llamarlo una sola vez en main.tsx antes de createRoot.
 */
export function installChunkLoadErrorHandler(): void {
  // Promise rejection sin handler (await import() en un service sin .catch).
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
