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
  // Sprint A2 (2026-05-19): offline-first encendido por default. Único
  // usuario activo es Lucas, no hay clientes externos. Si rompe algo, el
  // user puede apagarlo desde Hardware o con un localStorage.setItem.
  // Cuando entren más usuarios reales, evaluar si dejarlo ON o gating
  // por tenant.
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
