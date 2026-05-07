// Helpers de formato AR.

export function formatARS(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '$0,00';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function parseARS(s: string): number {
  // Acepta "$1.234,56" / "1234,56" / "1234.56" / "1234"
  const cleaned = s.replace(/[^\d,.-]/g, '');
  // Si tiene "," y "." asume formato AR: "." miles, "," decimal.
  if (cleaned.includes(',') && cleaned.includes('.')) {
    return Number(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
  }
  if (cleaned.includes(',')) return Number(cleaned.replace(',', '.')) || 0;
  return Number(cleaned) || 0;
}

// Sprint 8 tarea 3: timezone configurable. Default Buenos Aires; los
// componentes pueden pasar un timezone distinto leído de useTimezone()
// para cuando entren clientes fuera de Argentina.
export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

export function formatFecha(iso: string | Date | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: timezone,
  }).format(d);
}

export function formatHora(iso: string | Date | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(d);
}

/** @deprecated Sprint 8: usar formatFecha(iso, useTimezone()) en componentes. */
export function formatFechaAR(iso: string | Date | null | undefined): string {
  return formatFecha(iso);
}

/** @deprecated Sprint 8: usar formatHora(iso, useTimezone()) en componentes. */
export function formatHoraAR(iso: string | Date | null | undefined): string {
  return formatHora(iso);
}

export function relativoCorto(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return 'hace segundos';
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)} h`;
  return formatFechaAR(d);
}
