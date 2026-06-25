import { describe, it, expect } from 'vitest';
import { calcularRango, bloqueTimeline, dentroDeTurno } from './reservasUtils';

describe('calcularRango', () => {
  it('sin items devuelve el rango por defecto 12–24', () => {
    const r = calcularRango([]);
    expect(r.rangoIni).toBe(12 * 60);
    expect(r.rangoFin).toBe(24 * 60);
    expect(r.horas[0]).toBe(12 * 60);
    expect(r.horas[r.horas.length - 1]).toBe(24 * 60);
    expect(r.horas).toHaveLength(13); // 12,13,...,24
  });

  it('expande hacia atrás si hay una reserva temprano', () => {
    const r = calcularRango([{ startMin: 10 * 60 + 30, durMin: 60 }]); // 10:30
    expect(r.rangoIni).toBe(10 * 60); // baja a las 10
    expect(r.rangoFin).toBe(24 * 60);
  });

  it('expande hacia adelante si una reserva termina tarde', () => {
    const r = calcularRango([{ startMin: 23 * 60 + 30, durMin: 90 }]); // 23:30 + 1:30 = 25:00
    expect(r.rangoFin).toBe(25 * 60);
  });

  it('clampa el fin a 30h y nunca deja fin < ini', () => {
    const r = calcularRango([{ startMin: 29 * 60, durMin: 600 }]);
    expect(r.rangoFin).toBeLessThanOrEqual(30 * 60);
    expect(r.rangoFin).toBeGreaterThanOrEqual(r.rangoIni);
  });
});

describe('bloqueTimeline', () => {
  it('posiciona left según el offset desde el inicio del rango', () => {
    const { left } = bloqueTimeline(20 * 60, 90, 12 * 60, 2); // 20:00, rango 12:00, 2px/min
    expect(left).toBe((20 * 60 - 12 * 60) * 2); // 8h * 60 * 2 = 960
  });

  it('el ancho es proporcional a la duración', () => {
    const { width } = bloqueTimeline(20 * 60, 120, 12 * 60, 2);
    expect(width).toBe(120 * 2 - 2);
  });

  it('respeta un ancho mínimo para reservas muy cortas', () => {
    const { width } = bloqueTimeline(20 * 60, 5, 12 * 60, 1, 38);
    expect(width).toBe(38);
  });
});

describe('dentroDeTurno', () => {
  it('incluye el inicio y excluye el fin', () => {
    expect(dentroDeTurno(20 * 60, 20 * 60, 22 * 60)).toBe(true);
    expect(dentroDeTurno(22 * 60, 20 * 60, 22 * 60)).toBe(false);
    expect(dentroDeTurno(21 * 60, 20 * 60, 22 * 60)).toBe(true);
    expect(dentroDeTurno(19 * 60, 20 * 60, 22 * 60)).toBe(false);
  });
});
