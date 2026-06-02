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
  //  - 2026-06-02 tarde: re-encendido tras agregar routing local en
  //    getVenta/listVentasItems/listVentas. PERO descubrimos que:
  //    (a) fn_abrir_venta_comanda_offline server-side fallaba con 400
  //        (numero_local NOT NULL violation — fix en migration
  //        202606021200, no aplicado todavía en prod cuando Lucas probó),
  //    (b) cobrar venta offline NO está implementado — no existe RPC
  //        fn_cobrar_venta_comanda_offline.
  //    Resultado: 11 ops pendientes en cola, "La venta no existe" al cobrar.
  //  - 2026-06-02 tarde (después): APAGADO de nuevo. Offline-first es
  //    un sprint completo que falta cerrar (RPC cobro + anular + tests
  //    E2E + cleanup ventas zombies).
  //
  // El POS funciona perfecto online — apagar este flag NO rompe nada.
  //
  // Para reactivar (riesgoso hoy): localStorage.setItem('comanda.ff.offline_first_ventas', '1')
  get offlineFirstVentas(): boolean {
    return getFlag('offline_first_ventas', 'VITE_FF_OFFLINE_FIRST_VENTAS', false);
  },
};

// Setter helper para que la UI pueda toggle. Se persiste en localStorage.
export function setFeatureFlag(key: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`comanda.ff.${key}`, value ? '1' : '0');
  // Reload para que componentes re-renderen con el flag nuevo
  if (typeof window !== 'undefined') window.location.reload();
}
