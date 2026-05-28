// =============================================================================
// utils.ts — proxy + helpers PASE-specific.
// =============================================================================
// AUDIT F7A#1 sprint #2 post-audit grande: los helpers compartidos con
// COMANDA/admin viven ahora en @pase/shared/utils. Este archivo re-exporta
// para mantener compat con todos los callers actuales (`from '../lib/utils'`)
// y agrega los helpers que SOLO PASE necesita (today deprecated +
// estadoFactura que depende de today).
//
// Re-exportados desde @pase/shared/utils:
//   - parseMonto, toISO, fmt_d, fmt_$, genId
//   - todayAR_ISO, now, toLocalISO, toBuenosAires, fmt_dt_ar, fmt_t_ar
//
// PASE-only acá:
//   - today (deprecated — captura al import)
//   - estadoFactura (deriva 'vencida' desde fecha de venc)
// =============================================================================

export {
  parseMonto, toISO, fmt_d, fmt_$, genId,
  todayAR_ISO, now, toLocalISO, toBuenosAires, fmt_dt_ar, fmt_t_ar,
} from "@pase/shared/utils";

import { toISO } from "@pase/shared/utils";

/**
 * AUDIT F4C #1: `today` queda capturado al primer import del módulo.
 * Una pestaña abierta a las 23:55 AR sigue viendo el día anterior 18h después
 * (bug confirmado: useBandejaEntrada usaba esto para filtrar facturas vencidas
 * → la lista de "vencidas" no se actualizaba cruzado el día sin reload).
 *
 * **Para código nuevo usar `now()`** que devuelve un Date fresh cada llamada.
 * Migración de los 20 callers de `today` es gradual (sprint dedicado).
 *
 * @deprecated Usar `now()` que retorna fecha actual sin caching.
 */
export const today = new Date();

// Estado efectivo de una factura — deriva "vencida" al vuelo cuando el
// estado guardado es "pendiente" y la fecha de vencimiento ya pasó.
// Antes los reportes y filtros hacían `factura.estado === 'vencida'` y
// dependían de un trigger SQL que actualice ese campo, pero no existe →
// facturas pendientes con vencimiento pasado se mostraban como
// "pendientes" en vez de "vencidas". Esta función calcula sin necesidad
// de mantener estado en DB.
export const estadoFactura = (
  f: { estado: string; venc?: string | null },
  hoyStr: string = toISO(today)
): string => {
  if (f.estado === "pendiente" && f.venc && f.venc < hoyStr) return "vencida";
  return f.estado;
};
