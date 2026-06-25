import { describe, it, expect } from 'vitest';
import { normalizarTelefonoAR, whatsAppUrl, aplicarPlantilla, plantillasPara, PLANTILLAS } from './campanasService';

describe('normalizarTelefonoAR', () => {
  it('celular de 10 dígitos → 549 + número', () => {
    expect(normalizarTelefonoAR('1156781234')).toBe('5491156781234');
  });
  it('54 + 10 dígitos (sin 9) inserta el 9', () => {
    expect(normalizarTelefonoAR('541156781234')).toBe('5491156781234');
  });
  it('ya normalizado se deja igual', () => {
    expect(normalizarTelefonoAR('5491156781234')).toBe('5491156781234');
  });
  it('vacío/sin dígitos → null', () => {
    expect(normalizarTelefonoAR('')).toBeNull();
    expect(normalizarTelefonoAR(null)).toBeNull();
    expect(normalizarTelefonoAR('---')).toBeNull();
  });
});

describe('whatsAppUrl', () => {
  it('arma wa.me con texto encodeado', () => {
    expect(whatsAppUrl('1156781234', 'Hola')).toBe('https://wa.me/5491156781234?text=Hola');
  });
  it('sin teléfono válido → null', () => {
    expect(whatsAppUrl(null, 'x')).toBeNull();
  });
});

describe('aplicarPlantilla', () => {
  it('reemplaza {nombre} por el primer nombre', () => {
    expect(aplicarPlantilla('Hola {nombre}!', 'Juan Pérez')).toBe('Hola Juan!');
  });
  it('reemplaza todas las ocurrencias', () => {
    expect(aplicarPlantilla('{nombre} {nombre}', 'Ana')).toBe('Ana Ana');
  });
  it('sin nombre usa fallback', () => {
    expect(aplicarPlantilla('Hola {nombre}', null)).toBe('Hola hola');
  });
});

describe('plantillasPara', () => {
  it('devuelve las plantillas de la sugerencia', () => {
    const ps = plantillasPara('reactivar');
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.sugerencias.includes('reactivar'))).toBe(true);
  });
  it('sugerencia desconocida → todas las plantillas (fallback)', () => {
    expect(plantillasPara('zzz').length).toBe(PLANTILLAS.length);
  });
});
