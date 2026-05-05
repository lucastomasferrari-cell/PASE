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
  getCountersPedidos,
} from './pedidosService';

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

describe('getCountersPedidos', () => {
  it('agrupa estados a tabs y devuelve counters', async () => {
    const inFn = vi.fn().mockResolvedValue({
      data: [
        { estado: 'necesita_aprobacion' },
        { estado: 'necesita_aprobacion' },
        { estado: 'enviada' },
        { estado: 'lista' },
        { estado: 'lista' },
        { estado: 'lista' },
      ],
      error: null,
    });
    const isM = vi.fn().mockReturnValue({ in: inFn });
    const eqM = vi.fn().mockReturnValue({ eq: () => ({ is: isM }) });
    const select = vi.fn().mockReturnValue({ eq: eqM });
    mockFrom.mockReturnValue({ select });

    const counters = await getCountersPedidos(1);
    expect(counters.necesita_aprobacion).toBe(2);
    expect(counters.activos).toBe(1);
    expect(counters.listos).toBe(3);
    expect(counters.programados).toBe(0);
  });
});
