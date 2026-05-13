// ─────────────────────────────────────────────────────────────────────
// Helpers de formato — fuente de verdad para currency y deltas.
// Sprint mayo 2026 (Commit 4 cosméticos).
//
// Regla: símbolo $ pegado al número (sin espacio).
// Regla: signos +/− (U+2212 para negativo, NO el guión común U+002D) pegados.
//
// NO usar Intl.NumberFormat con { style: 'currency', currency: 'ARS' }
// porque el browser mete espacio entre el símbolo y los dígitos
// (depende del locale interno) y no se puede controlar sin un workaround.
// Usamos toLocaleString puro y concatenamos el símbolo manualmente.
// ─────────────────────────────────────────────────────────────────────

/**
 * Formato canónico de moneda en pesos argentinos.
 * Devuelve siempre el símbolo $ pegado al número, sin espacios.
 *
 * @example
 *   formatCurrency(1240000)  // "$1.240.000"
 *   formatCurrency(0)        // "$0"
 *   formatCurrency(-5400.5)  // "−$5.400,5"  (signo Unicode pegado)
 */
export function formatCurrency(value: number): string {
  if (value < 0) {
    return `−$${Math.abs(value).toLocaleString("es-AR")}`;
  }
  return `$${value.toLocaleString("es-AR")}`;
}

/**
 * Formato compacto (k, M) para valores grandes. Útil en chips y
 * footers de cards donde el espacio es limitado.
 *
 * @example
 *   formatCurrencyCompact(42_100_000)  // "$42.10M"
 *   formatCurrencyCompact(180_000)     // "$180k"
 *   formatCurrencyCompact(450)         // "$450"
 */
export function formatCurrencyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(0)}k`;
  }
  return `${sign}$${abs}`;
}

/**
 * Formato canónico de delta con signo. El signo va PEGADO al número.
 * Usa U+2212 (signo menos Unicode) para negativos, no U+002D (guión).
 *
 * @example
 *   formatDelta(2.1, "pts")    // "+2,1 pts"
 *   formatDelta(-1.4, "pts")   // "−1,4 pts"
 *   formatDelta(4.8, "%")      // "+4,8%"
 *   formatDelta(-45000, "$")   // "−$45.000"   (currency con signo pegado)
 *   formatDelta(0.5, "")       // "+0,5"
 */
export function formatDelta(value: number, unit: "pts" | "%" | "$" | "" = ""): string {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);

  if (unit === "$") {
    return `${sign}$${abs.toLocaleString("es-AR")}`;
  }
  // pts y %: una decimal con coma decimal.
  const formatted = abs.toFixed(1).replace(".", ",");
  if (unit === "%") return `${sign}${formatted}%`;
  if (unit === "pts") return `${sign}${formatted} pts`;
  return `${sign}${formatted}`;
}

/** Alias corto para uso en componentes existentes que ya usan fmtMoney. */
export const fmt_money = formatCurrency;
