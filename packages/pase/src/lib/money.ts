// =============================================================================
// AUDIT F4C#8 — Money math centralizado
// =============================================================================
// JS no tiene aritmética decimal nativa: 0.1 + 0.2 = 0.30000000000000004.
// Sumar/restar/multiplicar precios o saldos sin cuidado acumula errores que
// terminan en "diferencia de $0.01" en cierres y reportes.
//
// Decisión 2026-05-27 (Lucas pidió sprint money helper): NO traemos Big.js
// (76 KB) por simplicidad. Implementamos helpers minimalistas que operan en
// CENTAVOS internamente (multiplicamos por 100 al entrar, dividimos al
// salir). Esto cubre 99% de los casos de plata AR (centavos como unidad
// mínima). Si en el futuro necesitamos precisión sub-centavo (porcentajes
// de impuestos, conversiones), migramos a Big.js.
//
// Convenciones:
//   - Toda función toma numbers (pesos con decimales) y devuelve number.
//   - Internamente convierte a centavos (Math.round) y opera ahí.
//   - moneyEq(a, b) compara con epsilon 0.005 (medio centavo).
//   - moneyKey(v) genera string canónico para usar como key de dedup
//     (clave usada por LectorExtractoMP.tsx para detectar duplicados).
// =============================================================================

/** Convierte pesos a centavos (integer). 12.34 → 1234 */
const toCents = (v: number): number => Math.round((v || 0) * 100);
/** Convierte centavos a pesos. 1234 → 12.34 */
const toPesos = (c: number): number => c / 100;

/** Suma N valores en pesos sin errores de float. */
export function moneyAdd(...values: number[]): number {
  return toPesos(values.reduce((acc, v) => acc + toCents(v), 0));
}

/** Resta b de a en pesos sin errores de float. */
export function moneySub(a: number, b: number): number {
  return toPesos(toCents(a) - toCents(b));
}

/** Multiplica un monto (pesos) por un escalar (cantidad / factor). */
export function moneyMul(amount: number, factor: number): number {
  return toPesos(Math.round(toCents(amount) * factor));
}

/** Redondea un monto a 2 decimales (pesos). */
export function moneyRound(v: number): number {
  return toPesos(toCents(v));
}

/** Compara dos montos con tolerancia de medio centavo. */
export function moneyEq(a: number, b: number): boolean {
  return Math.abs(toCents(a) - toCents(b)) <= 0.5;
}

/**
 * Genera una clave canónica string para usar en deduplicación.
 * Garantiza que 12.3 y 12.30 produzcan la misma key.
 * Usar SIEMPRE este helper cuando el valor de plata es parte de una key
 * (Map, Set, dedup).
 */
export function moneyKey(v: number): string {
  // toFixed(2) produce "12.30" para 12.3 — bien para key porque siempre
  // tiene la misma forma. Usamos integer cents para que "12.300000001"
  // y "12.3" sean idénticos:
  return String(toCents(v));
}

/** Suma valores agrupados, devolviendo el total redondeado al centavo. */
export function moneySum<T>(items: T[], extractor: (item: T) => number): number {
  return moneyAdd(...items.map(extractor));
}
