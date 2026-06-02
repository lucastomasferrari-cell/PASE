// ─────────────────────────────────────────────────────────────────────────
// Detección automática de versión nueva post-deploy
// ─────────────────────────────────────────────────────────────────────────
//
// Problema: cuando deployamos, los users que tienen la app abierta siguen
// con el bundle viejo en memoria. Esto genera errores tipo "Failed to fetch
// dynamically imported module" cuando intentan abrir una pantalla nueva.
//
// Solución: en cada build, vite genera `dist/version.json` con el hash del
// commit Y embebe ese hash en el bundle vía `__BUILD_VERSION__`. El hook
// abajo fetchea `version.json` cada 5 minutos (con cache-bust) y al volver
// a foco. Si la versión del server difiere de la del bundle → reload.
//
// HISTORIA — pedido vs realidad:
//   - 31-may (Lucas): "después de un deployment nuevo tenés que desconectar
//     obligatoriamente a todos los usuarios". Razón: bug del JWT stale sin
//     app_metadata.tenant_id (users viejos quedaban con sidebar vacío).
//     Implementamos signOut + reload.
//   - 2-jun (Lucas, queja recurrente): "la sesión se cierra muy rápido".
//     Causa: con ~25 deploys en 1 día (sesión maratónica), cada deploy
//     deslogueaba a Lucas/Anto. Frustrante.
//   - Fix: hacer SOLO reload, sin signOut. El bug viejo del JWT sin
//     tenant_id ya está fixeado en App.tsx:319-350 (refreshSession +
//     signOut fallback solo si refresh tampoco sirve). Para users nuevos
//     y todos los existentes saneados, el JWT sigue siendo válido post-
//     deploy — solo cambiar el bundle es suficiente.
//
// Si en el futuro vuelve a aparecer el bug "sidebar vacío post-deploy"
// (que sería muy raro porque está cerrado), el handler de App.tsx
// detecta la falta de tenant_id en JWT y dispara refreshSession() solo.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";

// Hash del commit embebido en build (ver vite.config.ts → `define`).
// En dev queda como `dev-<timestamp>` y nunca matchea version.json, pero
// como version.json solo se genera en build, en dev la comparación nunca
// dispara (fetch falla en dev por 404 y se ignora).
declare const __BUILD_VERSION__: string;

const POLL_MS = 5 * 60_000;   // 5 minutos
const VERSION_URL = "/version.json";

async function fetchServerVersion(): Promise<string | null> {
  try {
    // Cache-bust para que el browser NO devuelva la version.json cacheada
    // (el SW puede tener una vieja).
    const resp = await fetch(`${VERSION_URL}?_=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

let _yaForzandoReload = false;

async function forzarReloadConservandoSesion(motivo: string) {
  if (_yaForzandoReload) return;
  _yaForzandoReload = true;
  console.warn(`[versionCheck] ${motivo} — reload (sesión conservada)`);
  // NO hacemos signOut. El JWT sigue siendo válido — solo cambia el bundle.
  // El listener onAuthStateChange en App.tsx detecta INITIAL_SESSION al
  // recargar y re-hidrata user/perfil/locales sin pedir password.
  //
  // OJO: NO limpiar sessionStorage 'pase_user' acá tampoco. Es cache de
  // perfil que App.tsx invalida solo via TOKEN_REFRESHED y SIGNED_OUT.
  // Si lo borráramos, la próxima vista podría parpadear hasta que el
  // listener corra de nuevo.
  //
  // Reload con cache busting (Vercel sirve index.html con no-cache, así
  // que `location.reload()` ya pide el HTML nuevo y el HTML linkea los
  // bundles con hash nuevo).
  window.location.reload();
}

/**
 * Instalar polling de versión. Llamarlo UNA vez al montar App.
 * - Cada 5 minutos: GET /version.json
 * - Cuando la pestaña vuelve al foco: GET /version.json
 * Si la versión del server difiere del bundle local → signOut + reload.
 */
export function useVersionPolling(): void {
  const localVersion = useRef<string>(typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "");

  useEffect(() => {
    // Si no hay versión local (dev sin build), no hacer polling — sería
    // ruido constante porque nunca matchea.
    if (!localVersion.current || localVersion.current.startsWith("dev-")) return;

    let cancelado = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      if (cancelado) return;
      const serverVersion = await fetchServerVersion();
      if (cancelado) return;
      if (!serverVersion) return;
      if (serverVersion !== localVersion.current) {
        await forzarReloadConservandoSesion(
          `Versión nueva detectada (server=${serverVersion}, local=${localVersion.current})`,
        );
      }
    };

    // Primera verificación al cabo de 30s para no penalizar el load inicial
    // (a los 30s el user ya está usando la app, si hay deploy reciente
    // detectamos rápido).
    const firstCheckTimer = setTimeout(() => { void check(); }, 30_000);

    // Polling cada 5 min
    intervalId = setInterval(() => { void check(); }, POLL_MS);

    // On focus: chequear al volver a la pestaña
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelado = true;
      clearTimeout(firstCheckTimer);
      if (intervalId) clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
