import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { rpc: (...args: unknown[]) => mockRpc(...args), from: () => ({}) },
}));

import { requiereOverride, calcularMontoDescuento, aplicarDescuento } from './descuentosService';

beforeEach(() => mockRpc.mockReset());

describe('requiereOverride', () => {
  it('porcentaje > 15% requiere override', () => {
    expect(requiereOverride('porcentaje', 16, 1000)).toBe(true);
    expect(requiereOverride('porcentaje', 15, 1000)).toBe(false);
    expect(requiereOverride('porcentaje', 10, 1000)).toBe(false);
  });
  it('monto > 20% del total requiere override', () => {
    expect(requiereOverride('monto', 250, 1000)).toBe(true);  // 25%
    expect(requiereOverride('monto', 200, 1000)).toBe(false); // exactamente 20%
    expect(requiereOverride('monto', 100, 1000)).toBe(false); // 10%
  });
});

describe('calcularMontoDescuento', () => {
  it('porcentaje calcula sobre subtotal', () => {
    expect(calcularMontoDescuento('porcentaje', 10, 1000)).toBe(100);
    expect(calcularMontoDescuento('porcentaje', 15, 5000)).toBe(750);
  });
  it('porcentaje fuera de rango → 0', () => {
    expect(calcularMontoDescuento('porcentaje', -5, 1000)).toBe(0);
    expect(calcularMontoDescuento('porcentaje', 150, 1000)).toBe(0);
  });
  it('monto fijo se devuelve tal cual (no negativo)', () => {
    expect(calcularMontoDescuento('monto', 250, 1000)).toBe(250);
    expect(calcularMontoDescuento('monto', -100, 1000)).toBe(0);
  });
  it('redondea a 2 decimales', () => {
    expect(calcularMontoDescuento('porcentaje', 12.5, 1234.56)).toBe(154.32);
  });
});

describe('aplicarDescuento', () => {
  it('llama fn_aplicar_descuento_comanda con monto calculado', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const res = await aplicarDescuento(
      { ventaId: 7, tipo: 'porcentaje', valor: 10, motivo: 'cliente frec', managerId: null },
      1000,
    );
    expect(mockRpc).toHaveBeenCalledWith('fn_aplicar_descuento_comanda', {
      p_venta_id: 7,
      p_monto: 100,
      p_motivo: 'cliente frec',
      p_manager_id: null,
    });
    expect(res.error).toBeNull();
  });
  it('si monto resulta 0, retorna error sin llamar la RPC', async () => {
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 0, motivo: 'x' },
      1000,
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(res.error).toBeTruthy();
  });
});
