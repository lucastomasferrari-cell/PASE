import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { rpc: (...args: unknown[]) => mockRpc(...args), from: () => ({}) },
}));

import { cobrar, refundVenta, newIdempotencyKey } from './pagosService';

beforeEach(() => mockRpc.mockReset());

describe('newIdempotencyKey', () => {
  it('genera valores únicos', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});

describe('cobrar', () => {
  it('rechaza si pagos vacío sin tocar la DB', async () => {
    const res = await cobrar(1, [], 0, null);
    expect(res.error).toMatch(/No hay pagos/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('manda pagos como array y propina', async () => {
    mockRpc.mockResolvedValue({ data: 1500, error: null });
    const pagos = [
      { metodo: 'efectivo', monto: 1000, idempotency_key: 'k1' },
      { metodo: 'tarjeta_debito', monto: 500, idempotency_key: 'k2' },
    ];
    const res = await cobrar(10, pagos, 100, 'emp-uuid');
    expect(mockRpc).toHaveBeenCalledWith('fn_cobrar_venta_comanda', {
      p_venta_id: 10, p_pagos: pagos, p_propina: 100, p_cobrado_por: 'emp-uuid',
    });
    expect(res.totalCobrado).toBe(1500);
  });

  it('mapea error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'SUMA_PAGOS_NO_COINCIDE' } });
    const res = await cobrar(1, [{ metodo: 'efectivo', monto: 100, idempotency_key: 'k' }], 0, null);
    expect(res.totalCobrado).toBe(0);
    expect(res.error).toBe('SUMA_PAGOS_NO_COINCIDE');
  });
});

describe('refundVenta', () => {
  it('llama fn_refund_venta_comanda', async () => {
    mockRpc.mockResolvedValue({ data: 5000, error: null });
    const res = await refundVenta(7, 'mgr', 'cliente arrepentido');
    expect(mockRpc).toHaveBeenCalledWith('fn_refund_venta_comanda', {
      p_venta_id: 7, p_manager_id: 'mgr', p_motivo: 'cliente arrepentido',
    });
    expect(res.totalReembolsado).toBe(5000);
  });
});
