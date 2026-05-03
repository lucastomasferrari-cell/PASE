// Cálculo del saldo MP visible en la card del header.
//
// Modelo (TASK 0.18 final — Path A1):
//   El saldo MP NO se calcula sumando todo el histórico de pay-* released
//   (eso da acumulado, no saldo real). Se basa en un saldo_inicial fijado
//   por el usuario en un momento puntual + suma incremental de TODOS los
//   movimientos pay-* posteriores a ese corte.
//
// Por qué fecha > saldo_inicial_at (estricto, no >=):
//   El usuario fija el saldo CON el estado actual ya reflejado. Los pagos
//   con date_created exacto al corte ya están dentro de saldo_inicial — si
//   los sumamos otra vez los contamos doble.
//
// Versión A (default): incluye TODOS los pay-* (pending + released). Razón:
// MP UI cuenta el saldo "available" inmediatamente cuando débito acredita,
// aunque la API devuelva pending por minutos. Si después de probar matchea
// mejor con released-only, cambiar a Versión B agregando filtro
// money_release_status === 'released'.

export interface MovParaSaldo {
  local_id: number;
  monto: number | string;
  fecha: string | null;
  anulado?: boolean;
}

export interface ComputeSaldoArgs {
  saldoInicial: number | string | null | undefined;
  saldoInicialAt: string | null | undefined;
  movs: MovParaSaldo[];
  localId: number;
}

export interface SaldoResult {
  /** null si no se puede calcular (sin saldo inicial fijado). */
  total: number | null;
  /** Cantidad de movs que contribuyeron a la suma. Útil para debug. */
  movsContados: number;
  /** Mensaje legible del estado. */
  motivo: 'sin_corte' | 'ok';
}

/**
 * Calcula saldo MP = saldo_inicial + SUM(monto WHERE fecha > saldo_inicial_at
 * AND local_id = X AND !anulado). Devuelve null si no hay saldo_inicial_at.
 */
export function computeSaldoMP({ saldoInicial, saldoInicialAt, movs, localId }: ComputeSaldoArgs): SaldoResult {
  if (!saldoInicialAt) {
    return { total: null, movsContados: 0, motivo: 'sin_corte' };
  }
  const cutoffMs = new Date(saldoInicialAt).getTime();
  if (!Number.isFinite(cutoffMs)) {
    return { total: null, movsContados: 0, motivo: 'sin_corte' };
  }
  const inicial = Number(saldoInicial) || 0;
  let delta = 0;
  let count = 0;
  for (const m of movs) {
    if (m.local_id !== localId) continue;
    if (m.anulado === true) continue;
    if (!m.fecha) continue;
    const t = new Date(m.fecha).getTime();
    if (!Number.isFinite(t)) continue;
    if (t <= cutoffMs) continue;  // estricto — fechas == corte ya están dentro de inicial
    delta += Number(m.monto) || 0;
    count++;
  }
  return {
    total: Math.round((inicial + delta) * 100) / 100,
    movsContados: count,
    motivo: 'ok',
  };
}

/**
 * Decide qué local mostrar en la card del saldo.
 *   localActivo set y visible → ese.
 *   localActivo null y un único local visible → ese.
 *   localActivo null y múltiples visibles → null (UI muestra "seleccioná primero").
 *   localActivo set pero no visible (caso raro de scope cambiado) → null.
 *
 * `visibleLocalIds`: lista de local_ids que el usuario puede ver. Para dueno/
 * admin sin _locales seteado pasamos los local_ids de las credenciales que sí
 * vio cargadas (ya están scopeadas por RLS).
 */
export function pickEffectiveLocalId(
  localActivo: number | null,
  visibleLocalIds: number[]
): number | null {
  if (visibleLocalIds.length === 0) return null;
  if (localActivo != null) {
    return visibleLocalIds.includes(localActivo) ? localActivo : null;
  }
  if (visibleLocalIds.length === 1) return visibleLocalIds[0] ?? null;
  return null;
}
