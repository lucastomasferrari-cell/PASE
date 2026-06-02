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
  // Historia:
  //  - 19-may: encendido sin soporte UI → bug "Cannot coerce".
  //  - 2026-06-02 mañana: apagado urgente.
  //  - 2026-06-02 tarde: rondas iterativas hasta cerrar todos los gaps:
  //    (a) Routing local en getVenta/listVentasItems/listVentas (541cd85).
  //    (b) Migration 202606021200: fix fn_abrir_venta_comanda_offline
  //        para calcular numero_local manualmente (sin trigger inexistente).
  //    (c) pagosService.cobrar wirea cobrarVentaOffline cuando el flag está ON.
  //    (d) ventasService.anularVenta wirea anularVentaOffline.
  //    Las RPCs server _offline ya existían desde 202605161500 (fn_cobrar,
  //    fn_anular, fn_aplicar_descuento, fn_anular_item, fn_cortesia,
  //    fn_modificar_precio, fn_transferir_mesa, fn_unir_mesas,
  //    fn_partir_cuenta) — solo faltaba el wiring frontend.
  //
  // Re-encendido por default (2da vez): ahora SÍ todo el flow está cerrado
  // server + client. Si algo rompe, apagar manual con:
  //   localStorage.setItem('comanda.ff.offline_first_ventas', '0')
  //
  // Helper de cleanup de zombies (si hay ventas trabadas en cola):
  //   window.__comandaCleanupOffline()  // expuesto en src/lib/db/cleanup.ts
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
