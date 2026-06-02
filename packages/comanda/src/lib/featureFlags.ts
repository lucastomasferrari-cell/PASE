// Feature flags para rollout gradual de capacidades nuevas.
//
// Override por usuario en runtime:
//   localStorage.setItem('comanda.ff.offline_first_ventas', '0')  // apagar
//   localStorage.setItem('comanda.ff.offline_first_ventas', '1')  // prender
//
// O en build time:
//   VITE_FF_OFFLINE_FIRST_VENTAS=0 (override del default)

function getFlag(key: string, envKey: string, defaultValue: boolean): boolean {
  // Runtime localStorage (override por usuario, útil para testing en prod sin
  // redeploy)
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(`comanda.ff.${key}`);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  // Build time env var
  const env = (typeof import.meta !== 'undefined' && import.meta.env)
    ? (import.meta.env as Record<string, string | undefined>)[envKey]
    : undefined;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return defaultValue;
}

export const featureFlags = {
  // Sprint A2 (2026-05-19): offline-first encendido por default.
  //
  // Historia (cronológica):
  //  - 19-may: encendido sin soporte UI → bug "Cannot coerce".
  //  - 2026-06-02 mañana: apagado urgente.
  //  - 2026-06-02 tarde: re-encendido tras cerrar wiring frontend (commits
  //    541cd85 + fe5a29c). PERO descubrimos que el server le faltaban
  //    RPCs (migration 202605161400 nunca se aplicó en prod) + bug en
  //    pushQueue routing (a3bdc2e fix).
  //  - 2026-06-02 noche: re-apagado por default. Lucas vio 11 pendientes
  //    (3+8 fallidas) en la UI porque las RPCs server no existen todavía.
  //    Pegar el SQL grande del mensaje a Lucas (sprint cierre completo)
  //    es prerequisito para reactivar el flag.
  //
  // El POS funciona perfecto ONLINE — apagar este flag NO rompe nada.
  //
  // 2026-06-02 noche (4ta vez, hopefully última):
  //   Lucas pegó TODAS las migrations server (offline RPCs + numero_local
  //   fix + cupones + crons + cleanup). Test E2E mutante backend
  //   (offline_first_mutante.spec.ts) verde en CI confirma que las RPCs
  //   _offline funcionan end-to-end. Re-encendido por default.
  //
  // Si Lucas/Anto reportan algo raro:
  //   1. Verificar que sea offline-first (no otra cosa) con:
  //      const dbReq = indexedDB.open('comanda-offline-db');
  //      → ver si hay zombies en pending_ops
  //   2. Apagar manual: localStorage.setItem('comanda.ff.offline_first_ventas', '0')
  //   3. Limpiar zombies: await __comandaCleanupOffline()
  //
  // Test que protege: packages/pase/tests/offline_first_mutante.spec.ts
  get offlineFirstVentas(): boolean {
    return getFlag('offline_first_ventas', 'VITE_FF_OFFLINE_FIRST_VENTAS', true);
  },
};

// Setter helper para que la UI pueda toggle. Se persiste en localStorage.
export function setFeatureFlag(key: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`comanda.ff.${key}`, value ? '1' : '0');
  // Reload para que componentes re-renderen con el flag nuevo
  if (typeof window !== 'undefined') window.location.reload();
}
