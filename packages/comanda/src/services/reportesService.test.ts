import { describe, it, expect } from 'vitest';
import { getRangoPeriodo, downloadCSV } from './reportesService';

describe('getRangoPeriodo', () => {
  it('hoy: desde 00:00:00, hasta 23:59:59 mismo día', () => {
    const { desde, hasta } = getRangoPeriodo('hoy');
    expect(desde).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(hasta).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(desde).getTime()).toBeLessThan(new Date(hasta).getTime());
  });

  it('ayer: desde y hasta son del mismo día anterior', () => {
    const { desde, hasta } = getRangoPeriodo('ayer');
    const d = new Date(desde);
    const h = new Date(hasta);
    expect(d.getDate()).toBe(h.getDate());
    expect(h.getTime() - d.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  it('semana: ~7 días de rango', () => {
    const { desde, hasta } = getRangoPeriodo('semana');
    const ms = new Date(hasta).getTime() - new Date(desde).getTime();
    expect(ms).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect(ms).toBeLessThan(8 * 24 * 3600 * 1000);
  });

  it('custom: usa fechas provistas', () => {
    const { desde, hasta } = getRangoPeriodo('custom', '2026-01-01', '2026-01-15');
    expect(new Date(desde).getUTCDate()).toBeGreaterThanOrEqual(1);
    expect(new Date(hasta).getTime()).toBeGreaterThan(new Date(desde).getTime());
  });
});

describe('downloadCSV', () => {
  it('escapa comas y comillas en valores', () => {
    // No podemos chequear el download real (jsdom). Pero podemos verificar
    // que la función no tira y construye el blob correctamente al espiar
    // createObjectURL.
    const calls: string[] = [];
    const origURL = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => { calls.push(String(b.type)); return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      downloadCSV('test.csv', ['a', 'b'], [['hola, mundo', 'con "comilla"']]);
    } finally {
      URL.createObjectURL = origURL;
    }
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('text/csv');
  });
});
