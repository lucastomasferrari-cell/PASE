import { describe, it, expect } from 'vitest';
import {
  formatARS, parseARS, relativoCorto,
  formatFecha, formatHora, formatFechaAR, formatHoraAR, DEFAULT_TIMEZONE,
} from './format';

describe('formatARS', () => {
  it('formatea valores normales', () => {
    expect(formatARS(1234.56)).toMatch(/1\.234,56/);
    expect(formatARS(0)).toMatch(/0,00/);
  });
  it('maneja null/undefined/NaN', () => {
    expect(formatARS(null)).toBe('$0,00');
    expect(formatARS(undefined)).toBe('$0,00');
    expect(formatARS(Number.NaN)).toBe('$0,00');
  });
});

describe('parseARS', () => {
  it('parsea formato AR clásico', () => {
    expect(parseARS('$1.234,56')).toBe(1234.56);
    expect(parseARS('1.234,56')).toBe(1234.56);
  });
  it('parsea formato sólo coma', () => {
    expect(parseARS('1234,56')).toBe(1234.56);
  });
  it('parsea formato US/sin separadores', () => {
    expect(parseARS('1234.56')).toBe(1234.56);
    expect(parseARS('1234')).toBe(1234);
  });
  it('strings vacíos o garbage → 0', () => {
    expect(parseARS('')).toBe(0);
    expect(parseARS('foo')).toBe(0);
  });
});

describe('relativoCorto', () => {
  it('null/undefined → string vacío', () => {
    expect(relativoCorto(null)).toBe('');
    expect(relativoCorto(undefined)).toBe('');
  });
  it('hace segundos para fechas recientes', () => {
    expect(relativoCorto(new Date().toISOString())).toBe('hace segundos');
  });
});

describe('formatFecha (sprint 8 — timezone configurable)', () => {
  // Fecha fija: 2026-05-07 03:30:00 UTC = 2026-05-07 00:30 ART = 2026-05-06 23:30 NYC.
  const iso = '2026-05-07T03:30:00.000Z';

  it('default Buenos Aires', () => {
    expect(formatFecha(iso)).toBe('07/05/2026');
  });

  it('Buenos Aires explícito', () => {
    expect(formatFecha(iso, 'America/Argentina/Buenos_Aires')).toBe('07/05/2026');
  });

  it('UTC distinto', () => {
    expect(formatFecha(iso, 'UTC')).toBe('07/05/2026');
  });

  it('New York distinto día (cruza medianoche)', () => {
    // 03:30 UTC el 07 = 23:30 NYC del 06.
    expect(formatFecha(iso, 'America/New_York')).toBe('06/05/2026');
  });

  it('null/undefined/empty → ""', () => {
    expect(formatFecha(null)).toBe('');
    expect(formatFecha(undefined)).toBe('');
    expect(formatFecha('')).toBe('');
  });

  it('fecha inválida → ""', () => {
    expect(formatFecha('not-a-date')).toBe('');
  });

  it('DEFAULT_TIMEZONE constante exportada', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Argentina/Buenos_Aires');
  });
});

describe('formatHora (sprint 8 — timezone configurable)', () => {
  // El formato legacy usa Intl 'es-AR' default que es 12-hour con
  // AM/PM en lowercase ("a. m." / "p. m."). Mantenemos el comportamiento
  // por compat. Si se prefiere 24h en POS, cambiar en sprint dedicado
  // agregando hour12: false (cambio de comportamiento documentado).
  const iso = '2026-05-07T03:30:00.000Z';

  it('default Buenos Aires (00:30 ART en 12h)', () => {
    // 03:30 UTC = 00:30 ART → 12:30 AM (12-hour).
    expect(formatHora(iso)).toMatch(/^12:30\s?a\.?\s?m\.?$/i);
  });

  it('UTC distinto a Buenos Aires', () => {
    expect(formatHora(iso, 'UTC')).toMatch(/^03:30\s?a\.?\s?m\.?$/i);
  });

  it('New York distinto día (cruza medianoche)', () => {
    // 03:30 UTC = 23:30 NYC del día anterior → 11:30 PM.
    expect(formatHora(iso, 'America/New_York')).toMatch(/^11:30\s?p\.?\s?m\.?$/i);
  });
});

describe('aliases legacy formatFechaAR / formatHoraAR (deprecated)', () => {
  const iso = '2026-05-07T03:30:00.000Z';

  it('formatFechaAR retorna lo mismo que formatFecha sin tz', () => {
    expect(formatFechaAR(iso)).toBe(formatFecha(iso));
  });

  it('formatHoraAR retorna lo mismo que formatHora sin tz', () => {
    expect(formatHoraAR(iso)).toBe(formatHora(iso));
  });
});
