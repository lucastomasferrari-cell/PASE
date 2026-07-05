import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  aprobarPedidoService, marcarListoService, marcarEntregadoService,
  getCountersPedidos, cancelarPedidoService, calcularEstadoPago,
} from './pedidosService';
import type { VentaPosPago } from '../types/database';

beforeEach(() => { mockRpc.mockReset(); mockFrom.mockReset(); });

describe('flow de pedidos', () => {
  it('aprobar llama fn_aprobar_pedido_comanda', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await aprobarPedidoService(99);
    expect(mockRpc).toHaveBeenCalledWith('fn_aprobar_pedido_comanda', { p_venta_id: 99 });
  });
  it('marcar listo llama fn_marcar_listo_comanda', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await marcarListoService(7);
    expect(mockRpc).toHaveBeenCalledWith('fn_marcar_listo_comanda', { p_venta_id: 7 });
  });
  it('marcar entregado llama fn_marcar_entregado_comanda', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await marcarEntregadoService(8);
    expect(mockRpc).toHaveBeenCalledWith('fn_marcar_entregado_comanda', { p_venta_id: 8 });
  });
});

describe('cancelarPedidoService', () => {
  it('llama fn_anular_venta_comanda con managerId + motivo', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await cancelarPedidoService(42, 'mgr-uuid-1', 'Cliente cancelo por demora');
    expect(mockRpc).toHaveBeenCalledWith('fn_anular_venta_comanda', {
      p_venta_id: 42,
      p_manager_id: 'mgr-uuid-1',
      p_motivo: 'Cliente cancelo por demora',
    });
  });
  it('devuelve error si la RPC falla', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'VENTA_YA_ANULADA' } });
    const r = await cancelarPedidoService(42, 'mgr', 'motivo');
    expect(r.error).toBe('VENTA_YA_ANULADA');
  });
});

describe('calcularEstadoPago', () => {
  // Helper para fabricar pagos confirmados (solo monto importa para esta función).
  const pago = (monto: number): VentaPosPago => ({
    id: 1, tenant_id: 't', local_id: 1, venta_id: 1,
    metodo: 'efectivo', monto, idempotency_key: 'k', vuelto: 0,
    propina_incluida: 0, cobrado_por: null, estado: 'confirmado',
    confirmado_at: null, reembolsado_at: null, created_at: '',
  });

  it('pagos confirmados que cubren el total → pagado', () => {
    expect(calcularEstadoPago(1500, [pago(1500)])).toBe('pagado');
  });
  it('suma de varios pagos confirmados ≥ total → pagado', () => {
    expect(calcularEstadoPago(1500, [pago(500), pago(1000)])).toBe('pagado');
  });
  it('suma de pagos < total → pendiente', () => {
    expect(calcularEstadoPago(1500, [pago(1000)])).toBe('pendiente');
  });
  it('sin pagos → pendiente', () => {
    expect(calcularEstadoPago(1500, [])).toBe('pendiente');
  });
  it('exact match (suma == total) → pagado', () => {
    expect(calcularEstadoPago(2350.75, [pago(1000), pago(1350.75)])).toBe('pagado');
  });
  it('total 0 con pagos vacíos → pagado (caso borde: pedido sin items)', () => {
    expect(calcularEstadoPago(0, [])).toBe('pagado');
  });
});

describe('getCountersPedidos', () => {
  it('agrupa estados a la taxonomía nueva (por_aceptar / programadas / aceptadas)', async () => {
    const futuro = new Date(Date.now() + 3_600_000).toISOString();
    const inFn = vi.fn().mockResolvedValue({
      data: [
        { estado: 'necesita_aprobacion', programada_para: null },
        { estado: 'necesita_aprobacion', programada_para: null },
        { estado: 'necesita_aprobacion', programada_para: futuro }, // → programadas
        { estado: 'abierta', programada_para: null },   // → aceptadas
        { estado: 'enviada', programada_para: null },   // → aceptadas
        { estado: 'lista', programada_para: null },     // → aceptadas
        { estado: 'lista', programada_para: null },     // → aceptadas
        { estado: 'programada', programada_para: futuro }, // → programadas
      ],
      error: null,
    });
    const isM = vi.fn().mockReturnValue({ in: inFn });
    const eqM = vi.fn().mockReturnValue({ eq: () => ({ is: isM }) });
    const select = vi.fn().mockReturnValue({ eq: eqM });
    mockFrom.mockReturnValue({ select });

    const counters = await getCountersPedidos(1);
    expect(counters.por_aceptar).toBe(2);
    expect(counters.programadas).toBe(2);
    expect(counters.aceptadas).toBe(4);
    expect(counters.cerradas).toBe(0);
    expect(counters.todos).toBe(0);
  });
});
