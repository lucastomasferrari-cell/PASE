import { describe, it, expect } from 'vitest';
import { formatARS, parseARS, relativoCorto } from './format';

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
