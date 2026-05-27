// =============================================================================
// @pase/shared — Money math centralizado
// =============================================================================
// AUDIT F7A#1 (consolidación @pase/shared): primer extract — money helpers
// que antes vivían en packages/pase/src/lib/money.ts. Ahora compartido con
// COMANDA + admin-console + cualquier paquete futuro.
//
// Ver design rationale en el archivo original.
// =============================================================================

const toCents = (v: number): number => Math.round((v || 0) * 100);
const toPesos = (c: number): number => c / 100;

export function moneyAdd(...values: number[]): number {
  return toPesos(values.reduce((acc, v) => acc + toCents(v), 0));
}
export function moneySub(a: number, b: number): number {
  return toPesos(toCents(a) - toCents(b));
}
export function moneyMul(amount: number, factor: number): number {
  return toPesos(Math.round(toCents(amount) * factor));
}
export function moneyRound(v: number): number {
  return toPesos(toCents(v));
}
export function moneyEq(a: number, b: number): boolean {
  return Math.abs(toCents(a) - toCents(b)) <= 0.5;
}
export function moneyKey(v: number): string {
  return String(toCents(v));
}
export function moneySum<T>(items: T[], extractor: (item: T) => number): number {
  return moneyAdd(...items.map(extractor));
}
