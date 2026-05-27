// =============================================================================
// @pase/shared — Time / timezone helpers
// =============================================================================
// AUDIT F7A#1: extract de utils.ts de PASE. Argentina = UTC-3 (sin DST).
// =============================================================================

export const AR_TZ = "America/Argentina/Buenos_Aires";

/** Devuelve la fecha de hoy formateada como YYYY-MM-DD en zona AR (UTC-3). */
export const todayAR_ISO = (): string => {
  const d = new Date();
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().split("T")[0]!;
};

/** Convierte un Date a YYYY-MM-DD usando componentes LOCALES del browser. */
export const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** Devuelve un Date nuevo (sin caching). */
export const now = (): Date => new Date();

export const toBuenosAires = (iso: string | Date): Date => {
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
