// Feature flags para rollout gradual de capacidades nuevas.
//
// Para activar: en build time `VITE_FF_OFFLINE_FIRST_VENTAS=1` o
// (mejor) en runtime via localStorage para flexibilidad:
//
//   localStorage.setItem('comanda.ff.offline_first_ventas', '1')
//
// Default false. La idea es que pase por una etapa de testing manual
// lado-a-lado online vs offline antes de hacer default true.

function getFlag(key: string, envKey: string): boolean {
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
  return env === '1' || env === 'true';
}

export const featureFlags = {
  // Fase 4.3: usar ventasOfflineService en lugar de los services online.
  // Default false. Activar manualmente cuando esté testeado.
  get offlineFirstVentas(): boolean {
    return getFlag('offline_first_ventas', 'VITE_FF_OFFLINE_FIRST_VENTAS');
  },
};

// Setter helper para que la UI pueda toggle. Se persiste en localStorage.
export function setFeatureFlag(key: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`comanda.ff.${key}`, value ? '1' : '0');
  // Reload para que componentes re-renderen con el flag nuevo
  if (typeof window !== 'undefined') window.location.reload();
}
