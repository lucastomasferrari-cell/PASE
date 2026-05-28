// =============================================================================
// @pase/shared — Format helpers (parseMonto / fmt_$ / fmt_d / genId / toISO)
// =============================================================================
// AUDIT F7A#1 sprint #2 post-audit grande: segundo extract de utils.ts a
// @pase/shared. Estos helpers se usan en PASE y COMANDA por igual y
// merecen viaje único.
//
// NO incluidos en este extract (siguen viviendo solo en PASE):
//   - `today` (DEPRECATED — captura al import del módulo; usar `now()` en su lugar)
//   - `estadoFactura` (depende de `today`, queda hasta que migre callers)
//
// Convención de toLocalISO (en time.ts) y toISO (acá): NO son intercambiables.
//   - toISO(d)      = d.toISOString().slice(0,10) → componentes UTC
//   - toLocalISO(d) = componentes LOCALES del browser
// Para filtros "fecha como la ve el user" → toLocalISO.
// Para timestamps absolutos UTC → toISO.
// =============================================================================

/**
 * Parsea un monto a número, tolerando formatos mixtos.
 *   "40642.56"   → 40642.56
 *   "40642,56"   → 40642.56  (coma decimal es-AR)
 *   "1.234,56"   → 1234.56   (punto de miles + coma decimal)
 *   "1,234.56"   → 1234.56   (coma de miles + punto decimal)
 *   40642.56     → 40642.56  (passthrough)
 *   null/""/NaN  → 0
 */
export const parseMonto = (v: unknown): number => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // Detectar si coma es decimal (única y cerca del final) o miles.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) normalized = s;
  else if (lastComma > lastDot) {
    // Coma es decimal, puntos son miles
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Punto es decimal (comas son miles)
    normalized = s.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};

/** Date → YYYY-MM-DD en UTC. Para componentes locales usar toLocalISO. */
export const toISO = (d: Date): string => d.toISOString().split("T")[0]!;

/** Formatea YYYY-MM-DD a DD/MM/YYYY estilo es-AR. Acepta null/undefined → "—". */
export const fmt_d = (d: string | null | undefined): string =>
  d ? new Date(d + "T12:00:00").toLocaleDateString("es-AR") : "—";

/**
 * Formatea número a moneda ARS. Siempre 2 decimales.
 *   $239.889,56  /  $1.000,00  /  -$50,00
 *
 * El símbolo $ va PEGADO al número, sin espacio (decisión 2026-05-13 —
 * design system v1.0). Intl.NumberFormat con style:'currency' mete un
 * espacio entre símbolo y dígitos que no se puede desactivar; se quita
 * con replace defensivo.
 */
export const fmt_$ = (n: number | null | undefined): string =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(n || 0)
    .replace(/^(\$|-\$|−\$)\s/, "$1");

/** Genera un id local con prefix + timestamp + random suffix. */
export const genId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
