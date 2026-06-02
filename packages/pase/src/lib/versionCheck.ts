// ─────────────────────────────────────────────────────────────────────────
// Detección automática de versión nueva post-deploy
// ─────────────────────────────────────────────────────────────────────────
//
// Problema: cuando deployamos, los users que tienen la app abierta siguen
// con el bundle viejo en memoria + JWT que puede quedar stale. Síntoma
// recurrente: refrescan y el sidebar pierde el selector de sucursales
// (RLS devuelve 0 sin error porque el JWT no tiene tenant_id).
//
// Solución: en cada build, vite genera `dist/version.json` con el hash del
// commit Y embebe ese hash en el bundle vía `__BUILD_VERSION__`. El hook
// abajo fetchea `version.json` cada 5 minutos (con cache-bust) y al volver
// a foco. Si la versión del server difiere de la del bundle → signOut +
// reload. Esto fuerza JWT fresh + bundle fresh sin que el user tenga que
// hacer nada.
//
// Pedido Lucas 31-may: "después de un deployment nuevo tenés que desconectar
// obligatoriamente a todos los usuarios".
//
// EXCEPCIÓN — flag "Mantener sesión abierta" (Lucas 2-jun):
// Si el user marcó el checkbox en login, persiste `pase_remember_me=true`
// en localStorage. En ese caso post-deploy hacemos SOLO reload (sin signOut).
// El user controla con el toggle si quiere logout automático o no.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { db } from "./supabase";

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

let _yaForzandoLogout = false;

// Flag persistido por el checkbox "Mantener sesión abierta" en Login.tsx.
// Si está en `true`, post-deploy hacemos SOLO reload (no signOut).
// Si está en `false` o no existe, se mantiene el comportamiento legacy
// (signOut + reload) — pedido original de Lucas 31-may.
const REMEMBER_ME_KEY = "pase_remember_me";

function isRememberMeActive(): boolean {
  try {
    return localStorage.getItem(REMEMBER_ME_KEY) === "true";
  } catch {
    return false;
  }
}

async function handleDeployDetectado(motivo: string) {
  if (_yaForzandoLogout) return;
  _yaForzandoLogout = true;

  if (isRememberMeActive()) {
    console.warn(`[versionCheck] ${motivo} — reload (sesión conservada por 'Mantener sesión')`);
    // Solo reload — el JWT sigue siendo válido, el listener onAuthStateChange
    // en App.tsx re-hidrata el perfil al detectar INITIAL_SESSION.
    window.location.reload();
    return;
  }

  console.warn(`[versionCheck] ${motivo} — signOut + reload`);
  try {
    await db.auth.signOut();
  } catch {
    // Aún si signOut falla (no había sesión), seguimos al reload.
  }
  // Limpiar cualquier cache local de perfil/local que App.tsx haya guardado.
  try {
    sessionStorage.removeItem("pase_user");
    sessionStorage.removeItem("pase_local_activo");
    localStorage.removeItem("pase_uid");
  } catch { /* idem */ }
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
        await handleDeployDetectado(
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
