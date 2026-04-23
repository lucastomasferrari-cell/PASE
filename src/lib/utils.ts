export const toISO = (d: Date) => d.toISOString().split("T")[0];
export const today = new Date();
export const fmt_d = (d: string | null | undefined) => d ? new Date(d+"T12:00:00").toLocaleDateString("es-AR") : "—";
export const fmt_$ = (n: number | null | undefined) => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(n||0);
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
