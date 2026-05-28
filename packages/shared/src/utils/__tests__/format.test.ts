// Tests de format.ts — helpers de formato compartidos PASE/COMANDA.
//
// parseMonto: tolera 5 formatos distintos (es-AR + en-US + mixto). Errores
// silenciosos a 0 — bug famoso si se cambia: la importación Maxirest hace
// `parseMonto(row.total)` y un NaN se propaga como 0 a la DB.
//
// fmt_$: el símbolo $ va PEGADO al número (decisión design system v1.0).
// Intl.NumberFormat mete espacio que se quita con replace.
//
// fmt_d: acepta null/undefined → "—". Si rompe esto los listados muestran
// "Invalid Date" en cada fila sin fecha.

import { describe, it, expect } from 'vitest';
import { parseMonto, toISO, fmt_d, fmt_$, genId } from '../format';

describe('parseMonto', () => {
  describe('null/empty inputs → 0', () => {
    it('null → 0', () => expect(parseMonto(null)).toBe(0));
    it('undefined → 0', () => expect(parseMonto(undefined)).toBe(0));
    it('"" → 0', () => expect(parseMonto("")).toBe(0));
    it('"   " (whitespace) → 0', () => expect(parseMonto("   ")).toBe(0));
    it('NaN → 0', () => expect(parseMonto(NaN)).toBe(0));
    it('"not a number" → 0', () => expect(parseMonto("not a number")).toBe(0));
  });

  describe('number passthrough', () => {
    it('40642.56 → 40642.56', () => expect(parseMonto(40642.56)).toBe(40642.56));
    it('0 → 0', () => expect(parseMonto(0)).toBe(0));
    it('Infinity → 0 (no finite)', () => expect(parseMonto(Infinity)).toBe(0));
  });

  describe('formato es-AR (coma decimal)', () => {
    it('"40642,56" → 40642.56', () => expect(parseMonto("40642,56")).toBe(40642.56));
    it('"1.234,56" (punto miles + coma decimal) → 1234.56', () => {
      expect(parseMonto("1.234,56")).toBe(1234.56);
    });
    it('"1.234.567,89" (varios miles) → 1234567.89', () => {
      expect(parseMonto("1.234.567,89")).toBe(1234567.89);
    });
  });

  describe('formato en-US (punto decimal)', () => {
    it('"40642.56" → 40642.56', () => expect(parseMonto("40642.56")).toBe(40642.56));
    it('"1,234.56" (coma miles + punto decimal) → 1234.56', () => {
      expect(parseMonto("1,234.56")).toBe(1234.56);
    });
    it('"1,234,567.89" → 1234567.89', () => {
      expect(parseMonto("1,234,567.89")).toBe(1234567.89);
    });
  });

  describe('edge cases', () => {
    it('"40642" (entero sin decimales) → 40642', () => {
      expect(parseMonto("40642")).toBe(40642);
    });
    it('"  100  " (con espacios) → 100', () => expect(parseMonto("  100  ")).toBe(100));
    it('"-50,50" (negativo es-AR) → -50.50', () => expect(parseMonto("-50,50")).toBe(-50.50));
    it('"0,00" → 0', () => expect(parseMonto("0,00")).toBe(0));
  });
});

describe('toISO', () => {
  it('Date 2026-05-27 12:00 UTC → "2026-05-27"', () => {
    const d = new Date(Date.UTC(2026, 4, 27, 12, 0, 0));
    expect(toISO(d)).toBe('2026-05-27');
  });

  it('Date al final del mes UTC → fecha UTC, no local', () => {
    // 31 mayo 23:30 UTC = 1 jun 20:30 AR (UTC+3)... wait, AR es UTC-3
    // 31 mayo 23:30 UTC = 31 mayo 20:30 AR
    // toISO devuelve componentes UTC → "2026-05-31"
    const d = new Date(Date.UTC(2026, 4, 31, 23, 30, 0));
    expect(toISO(d)).toBe('2026-05-31');
  });
});

describe('fmt_d', () => {
  it('null → "—"', () => expect(fmt_d(null)).toBe('—'));
  it('undefined → "—"', () => expect(fmt_d(undefined)).toBe('—'));
  it('"" → "—"', () => expect(fmt_d('')).toBe('—'));
  it('"2026-05-27" → "27/5/2026" (es-AR)', () => {
    // Intl puede variar según locale del runtime — toLowerCase para tolerar
    // diferencias menores. Lo crítico es que NO devuelva "Invalid Date".
    const out = fmt_d('2026-05-27');
    expect(out).toMatch(/27.*5.*2026/);
    expect(out).not.toContain('Invalid');
  });
});

describe('fmt_$', () => {
  it('null → "$0,00"', () => {
    // Símbolo pegado al número (sin espacio entre $ y dígito)
    const out = fmt_$(null);
    expect(out).toMatch(/^\$0,00$/);
  });

  it('undefined → "$0,00"', () => {
    expect(fmt_$(undefined)).toMatch(/^\$0,00$/);
  });

  it('1000 → "$1.000,00"', () => {
    expect(fmt_$(1000)).toBe('$1.000,00');
  });

  it('239889.56 → "$239.889,56"', () => {
    expect(fmt_$(239889.56)).toBe('$239.889,56');
  });

  it('-50 → "-$50,00" (negativo con menos pegado)', () => {
    // El replace remueve espacio después de "-$"
    expect(fmt_$(-50)).toBe('-$50,00');
  });

  it('1234567.89 → "$1.234.567,89"', () => {
    expect(fmt_$(1234567.89)).toBe('$1.234.567,89');
  });
});

describe('genId', () => {
  it('respeta el prefix', () => {
    const id = genId('test');
    expect(id.startsWith('test-')).toBe(true);
  });

  it('contiene timestamp + random suffix', () => {
    // formato: <prefix>-<timestamp>-<4 random chars>
    const id = genId('foo');
    expect(id).toMatch(/^foo-\d{13}-[a-z0-9]{4}$/);
  });

  it('genera IDs distintos en llamadas rápidas (random suffix)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(genId('x'));
    // Algunas colisiones son posibles pero raras (36^4 = 1.6M combinaciones).
    // Si <80% son únicos hay un problema con el random.
    expect(ids.size).toBeGreaterThan(80);
  });
});
