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

export const toISO = (d: Date) => d.toISOString().split("T")[0];
export const today = new Date();
export const fmt_d = (d: string | null | undefined) => d ? new Date(d+"T12:00:00").toLocaleDateString("es-AR") : "—";
// Siempre muestra 2 decimales (ej: $ 239.889,56 o $ 1.000,00). Antes
// usaba maximumFractionDigits:0 que truncaba y escondía los centavos
// relevantes de IVA (bug #28). Montos enteros quedan como "$ 1.000,00"
// que es legible en es-AR.
export const fmt_$ = (n: number | null | undefined) => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0);
export const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

// Timezone helpers — Argentina es UTC-3 todo el año (no tiene DST).
// Los timestamps en la DB están en UTC; estos helpers los formatean en zona AR.
const AR_TZ = "America/Argentina/Buenos_Aires";

export const toBuenosAires = (iso: string | Date): Date => {
  // Devuelve un Date que al formatear con timeZone: AR_TZ muestra la hora local.
  // JS Date siempre es UTC internamente — el offset lo aplica el formateador.
  return typeof iso === "string" ? new Date(iso) : iso;
};

export const fmt_dt_ar = (iso: string | Date | null | undefined): string => {
  if (!iso) return "—";
  const d = toBuenosAires(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: AR_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
};

export const fmt_t_ar = (iso: string | Date | null | undefined): string => {
  if (!iso) return "—";
  const d = toBuenosAires(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: AR_TZ,
    hour: "2-digit", minute: "2-digit",
  }).format(d);
};
