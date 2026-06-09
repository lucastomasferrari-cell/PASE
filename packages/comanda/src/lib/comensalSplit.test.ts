import { describe, it, expect } from 'vitest';
import { calcularCuentasPorComensal } from './comensalSplit';

describe('calcularCuentasPorComensal', () => {
  it('reparte ítems asignados a cada comensal', () => {
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: 1, subtotal: 1000 },
      { id: 2, comensal: 2, subtotal: 500 },
      { id: 3, comensal: 1, subtotal: 300 },
    ], 2);
    expect(r.cuentas[0]!.monto).toBe(1300);
    expect(r.cuentas[1]!.monto).toBe(500);
    expect(r.cuentas[0]!.itemIds).toEqual([1, 3]);
    expect(r.neto).toBe(1800);
  });

  it('divide los compartidos (NULL) en partes iguales', () => {
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: 1, subtotal: 1000 },
      { id: 2, comensal: null, subtotal: 600 }, // compartido entre 3
    ], 3);
    expect(r.compartidoTotal).toBe(600);
    expect(r.cuentas[0]!.monto).toBe(1200); // 1000 + 200
    expect(r.cuentas[1]!.monto).toBe(200);
    expect(r.cuentas[2]!.monto).toBe(200);
  });

  it('prorratea el descuento de la venta (factor neto/bruto)', () => {
    // bruto 2000, descuento 200 → factor 0.9
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: 1, subtotal: 1000 },
      { id: 2, comensal: 2, subtotal: 1000 },
    ], 2, 200);
    expect(r.neto).toBe(1800);
    expect(r.cuentas[0]!.monto).toBe(900);
    expect(r.cuentas[1]!.monto).toBe(900);
  });

  it('Σ montos = neto exacto aún con división con resto (remanente al último)', () => {
    // 1000 compartido entre 3 → 333.33 c/u, el último absorbe el resto
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: null, subtotal: 1000 },
    ], 3);
    const suma = r.cuentas.reduce((s, c) => s + c.monto, 0);
    expect(Math.round(suma * 100) / 100).toBe(1000);
  });

  it('ítem con comensal fuera de rango cae a compartido', () => {
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: 5, subtotal: 900 }, // solo hay 2 comensales
    ], 2);
    expect(r.compartidoTotal).toBe(900);
    expect(r.cuentas[0]!.monto).toBe(450);
    expect(r.cuentas[1]!.monto).toBe(450);
  });

  it('numComensales < 1 se normaliza a 1', () => {
    const r = calcularCuentasPorComensal([
      { id: 1, comensal: null, subtotal: 500 },
    ], 0);
    expect(r.cuentas).toHaveLength(1);
    expect(r.cuentas[0]!.monto).toBe(500);
  });
});
