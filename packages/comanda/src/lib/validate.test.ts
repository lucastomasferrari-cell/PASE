import { describe, it, expect } from 'vitest';
import { validarNombre, validarPrecio, validarPorcentaje, validarSlug, validarMinMax } from './validate';

describe('validarNombre', () => {
  it('rechaza vacíos y espacios', () => {
    expect(validarNombre('')).toMatch(/vacío/);
    expect(validarNombre('   ')).toMatch(/vacío/);
    expect(validarNombre(null)).toMatch(/vacío/);
    expect(validarNombre(undefined)).toMatch(/vacío/);
  });
  it('acepta válidos', () => {
    expect(validarNombre('Hamburguesa')).toBeNull();
  });
  it('rechaza > 200 chars', () => {
    expect(validarNombre('x'.repeat(201))).toMatch(/200/);
  });
});

describe('validarPrecio', () => {
  it('acepta 0 y positivos', () => {
    expect(validarPrecio(0)).toBeNull();
    expect(validarPrecio(1500)).toBeNull();
  });
  it('rechaza negativos', () => {
    expect(validarPrecio(-1)).toMatch(/negativo/);
  });
  it('rechaza NaN/null/undefined', () => {
    expect(validarPrecio(Number.NaN)).toMatch(/inválido/);
    expect(validarPrecio(null)).toMatch(/inválido/);
    expect(validarPrecio(undefined)).toMatch(/inválido/);
  });
  it('rechaza fuera de rango', () => {
    expect(validarPrecio(1e9)).toMatch(/rango/);
  });
});

describe('validarPorcentaje', () => {
  it('acepta -100 a 1000', () => {
    expect(validarPorcentaje(0)).toBeNull();
    expect(validarPorcentaje(15)).toBeNull();
    expect(validarPorcentaje(-50)).toBeNull();
  });
  it('rechaza fuera de rango', () => {
    expect(validarPorcentaje(-200)).toMatch(/rango/);
    expect(validarPorcentaje(2000)).toMatch(/rango/);
  });
});

describe('validarSlug', () => {
  it('acepta válidos', () => {
    expect(validarSlug('rappi')).toBeNull();
    expect(validarSlug('pedidos-ya')).toBeNull();
    expect(validarSlug('canal-123')).toBeNull();
  });
  it('rechaza mayúsculas, espacios o símbolos', () => {
    expect(validarSlug('Rappi')).toMatch(/minúsculas/);
    expect(validarSlug('pedidos ya')).toMatch(/minúsculas/);
    expect(validarSlug('canal!')).toMatch(/minúsculas/);
  });
  it('rechaza vacío', () => {
    expect(validarSlug('')).toMatch(/requerido/);
  });
});

describe('validarMinMax', () => {
  it('acepta min<=max y max null', () => {
    expect(validarMinMax(0, 1)).toBeNull();
    expect(validarMinMax(2, 5)).toBeNull();
    expect(validarMinMax(0, null)).toBeNull();
  });
  it('rechaza min negativo', () => {
    expect(validarMinMax(-1, 1)).toMatch(/negativo/);
  });
  it('rechaza max < min', () => {
    expect(validarMinMax(3, 1)).toMatch(/menor/);
  });
});
