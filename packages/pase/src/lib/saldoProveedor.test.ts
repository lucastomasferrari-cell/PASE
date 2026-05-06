import { describe, it, expect } from 'vitest';
import { calcularSaldosPorProveedor } from './saldoProveedor';

const PROV = 1;

describe('calcularSaldosPorProveedor — casos del prompt', () => {
  it('A) 1 remito $10.000 sin facturar → $10.000', () => {
    const m = calcularSaldosPorProveedor([], [
      { prov_id: PROV, monto: 10000, estado: 'sin_factura', factura_id: null },
    ]);
    expect(m.get(PROV)).toBe(10000);
  });

  it('B) 1 factura pendiente $20.000 → $20.000', () => {
    const m = calcularSaldosPorProveedor([
      { prov_id: PROV, total: 20000, estado: 'pendiente', tipo: 'factura' },
    ], []);
    expect(m.get(PROV)).toBe(20000);
  });

  it('C) 1 remito vinculado a 1 factura $10.000 → $10.000 (no $20.000)', () => {
    const m = calcularSaldosPorProveedor(
      [{ prov_id: PROV, total: 10000, estado: 'pendiente' }],
      [{ prov_id: PROV, monto: 10000, estado: 'vinculado', factura_id: 'F-1' }],
    );
    expect(m.get(PROV)).toBe(10000);
  });

  it('D) 1 remito $10.000 + 1 factura $20.000 distintos → $30.000', () => {
    const m = calcularSaldosPorProveedor(
      [{ prov_id: PROV, total: 20000, estado: 'pendiente' }],
      [{ prov_id: PROV, monto: 10000, estado: 'sin_factura', factura_id: null }],
    );
    expect(m.get(PROV)).toBe(30000);
  });

  it('E) 1 remito pagado → $0', () => {
    const m = calcularSaldosPorProveedor([], [
      { prov_id: PROV, monto: 5000, estado: 'pagado', factura_id: null },
    ]);
    expect(m.get(PROV)).toBeUndefined();
  });
});

describe('calcularSaldosPorProveedor — extras', () => {
  it('factura con pagos parciales descuenta', () => {
    const m = calcularSaldosPorProveedor([
      { prov_id: PROV, total: 10000, estado: 'pendiente',
        pagos: [{ monto: 3000 }, { monto: 2000 }] },
    ], []);
    expect(m.get(PROV)).toBe(5000);
  });

  it('factura pagada no aporta', () => {
    const m = calcularSaldosPorProveedor([
      { prov_id: PROV, total: 10000, estado: 'pagada' },
    ], []);
    expect(m.get(PROV)).toBeUndefined();
  });

  it('nota de crédito resta', () => {
    const m = calcularSaldosPorProveedor([
      { prov_id: PROV, total: 20000, estado: 'pendiente' },
      { prov_id: PROV, total: 5000,  estado: 'pendiente', tipo: 'nota_credito' },
    ], []);
    expect(m.get(PROV)).toBe(15000);
  });

  it('remito anulado no cuenta', () => {
    const m = calcularSaldosPorProveedor([], [
      { prov_id: PROV, monto: 10000, estado: 'anulado', factura_id: null },
    ]);
    expect(m.get(PROV)).toBeUndefined();
  });

  it('remito vinculado no cuenta aunque estado sea sin_factura legacy', () => {
    // Caso defensivo: si por algún motivo factura_id quedó seteado pero
    // estado siguió en sin_factura, el factura_id manda.
    const m = calcularSaldosPorProveedor([], [
      { prov_id: PROV, monto: 10000, estado: 'sin_factura', factura_id: 'F-99' },
    ]);
    expect(m.get(PROV)).toBeUndefined();
  });

  it('múltiples proveedores coexisten', () => {
    const m = calcularSaldosPorProveedor(
      [{ prov_id: 1, total: 1000, estado: 'pendiente' },
       { prov_id: 2, total: 500,  estado: 'pendiente' }],
      [{ prov_id: 1, monto: 200, estado: 'sin_factura', factura_id: null }],
    );
    expect(m.get(1)).toBe(1200);
    expect(m.get(2)).toBe(500);
  });

  it('total como string (PostgREST devuelve numerics como string)', () => {
    const m = calcularSaldosPorProveedor([
      { prov_id: PROV, total: '10000.50' as unknown as number, estado: 'pendiente',
        pagos: [{ monto: '500.50' as unknown as number }] },
    ], []);
    expect(m.get(PROV)).toBe(9500);
  });
});
