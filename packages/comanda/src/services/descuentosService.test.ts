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
      p_idempotency_key: null,
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

  // Sprint 8 — casos negativos del backend (RAISE EXCEPTION mapeados al frontend).
  it('mapea SIN_PERMISO_DESCUENTO sin manager', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SIN_PERMISO_DESCUENTO' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 5, motivo: 'cliente' },
      1000,
    );
    expect(res.error).toBe('SIN_PERMISO_DESCUENTO');
  });

  it('mapea MANAGER_REQUERIDO_DESCUENTO_GRANDE (>15% sin manager)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'MANAGER_REQUERIDO_DESCUENTO_GRANDE' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 20, motivo: 'cliente' },
      1000,
    );
    expect(res.error).toContain('MANAGER_REQUERIDO');
  });

  it('mapea MANAGER_INVALIDO (manager no existe o no tiene rol)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'MANAGER_INVALIDO' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 20, motivo: 'x', managerId: 'fake-uuid' },
      1000,
    );
    expect(res.error).toBe('MANAGER_INVALIDO');
  });

  it('mapea EMPLEADO_NO_EN_LOCAL (sprint 7 IDOR — manager de otro local)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'EMPLEADO_NO_EN_LOCAL: empleado abc no pertenece al local 5' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'porcentaje', valor: 20, motivo: 'x', managerId: 'mgr-other-local' },
      1000,
    );
    expect(res.error).toContain('EMPLEADO_NO_EN_LOCAL');
  });

  it('mapea VENTA_NO_ENCONTRADA', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'VENTA_NO_ENCONTRADA' },
    });
    const res = await aplicarDescuento(
      { ventaId: 999, tipo: 'porcentaje', valor: 5, motivo: 'x' },
      1000,
    );
    expect(res.error).toBe('VENTA_NO_ENCONTRADA');
  });

  it('mapea DESCUENTO_INVALIDO (sprint 7 — supera subtotal+propina)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DESCUENTO_INVALIDO: el descuento (200) supera el subtotal+propina (100)' },
    });
    const res = await aplicarDescuento(
      { ventaId: 1, tipo: 'monto', valor: 200, motivo: 'x' },
      100,
    );
    expect(res.error).toContain('DESCUENTO_INVALIDO');
  });
});
