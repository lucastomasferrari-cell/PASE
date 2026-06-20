import type { ExtractoMovimiento } from "./mpExtractoParser";

/**
 * Detecta transferencias que se enviaron Y se devolvieron dentro del mismo
 * extracto: un egreso (monto < 0) y una devolución (monto > 0) con el mismo
 * `referencia_externa` y el mismo monto absoluto. Netean cero → no son un pago
 * real y no deben entrar al cruce.
 *
 * Devuelve el set de `referencia_externa` neteadas. El egreso con esa ref se
 * saca del pool de matching; se muestra aparte como "devuelta — ignorada".
 *
 * Tolerancia de $1 para absorber redondeos de centavos del extracto.
 */
export function refsDevueltas(movs: ExtractoMovimiento[]): Set<string> {
  const egresoPorRef = new Map<string, number>();
  for (const m of movs) {
    if (m.monto < 0 && m.referencia_externa) {
      egresoPorRef.set(m.referencia_externa, Math.abs(m.monto));
    }
  }
  const refs = new Set<string>();
  for (const m of movs) {
    if (m.monto > 0 && m.referencia_externa) {
      const montoEgreso = egresoPorRef.get(m.referencia_externa);
      if (montoEgreso != null && Math.abs(montoEgreso - m.monto) < 1) {
        refs.add(m.referencia_externa);
      }
    }
  }
  return refs;
}
