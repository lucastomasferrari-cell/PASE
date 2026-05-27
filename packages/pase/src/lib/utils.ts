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

export const toISO = (d: Date): string => d.toISOString().split("T")[0]!;

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

/** Devuelve un Date nuevo (sin caching). Usar en código nuevo. */
export const now = (): Date => new Date();

/** Devuelve la fecha de hoy formateada como YYYY-MM-DD en zona AR (UTC-3, sin DST). */
export const todayAR_ISO = (): string => {
  const d = new Date();
  // Argentina = UTC-3 constante. Restamos 3 horas y leemos UTC parts.
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().split("T")[0]!;
};

/**
 * AUDIT F4C #2: convierte cualquier Date a YYYY-MM-DD usando las
 * COMPONENTES LOCALES (lo que el browser muestra), no UTC. Esto es lo que
 * queremos al filtrar por "fecha" en queries — la fecha como la ve el user.
 *
 * toLocalISO(`d)` siempre devuelve UTC → en AR (UTC-3) a las
 * 21-23:59 del día N devuelve la fecha N+1, corriendo los filtros al
 * día siguiente. `toLocalISO(d)` arregla eso.
 */
export const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

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
export const fmt_d = (d: string | null | undefined) => d ? new Date(d+"T12:00:00").toLocaleDateString("es-AR") : "—";
// Siempre muestra 2 decimales (ej: $239.889,56 o $1.000,00). El símbolo
// $ va PEGADO al número, sin espacio (decisión 2026-05-13 — design system
// v1.0). Intl.NumberFormat con style:'currency' mete un espacio entre
// símbolo y dígitos que no se puede desactivar; se quita con replace.
export const fmt_$ = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(n || 0)
    .replace(/^(\$|-\$|−\$)\s/, "$1");
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
