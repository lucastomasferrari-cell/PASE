import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../lib/supabaseAnon', () => ({
  dbAnon: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

import { getLocalPorToken, getCatalogoPorToken, crearPedidoMenuQr } from './menuQrService';

beforeEach(() => mockRpc.mockReset());

describe('menuQrService', () => {
  it('getLocalPorToken devuelve la primer fila', async () => {
    mockRpc.mockResolvedValue({
      data: [{ local_id: 1, local_nombre: 'Neko VC', mesa_id: 5, mesa_numero: '12', mesa_zona: null, modo: 'asistido' }],
      error: null,
    });
    const r = await getLocalPorToken('tok');
    expect(r.data?.modo).toBe('asistido');
    expect(r.data?.mesa_numero).toBe('12');
  });

  it('crearPedidoMenuQr arma el payload con idempotency', async () => {
    mockRpc.mockResolvedValue({ data: [{ venta_id: 999, numero_local: 47 }], error: null });
    const r = await crearPedidoMenuQr({
      token: 'tok',
      items: [{ item_id: 10, cantidad: 2 }],
      idempotencyKey: 'KEY-1',
    });
    expect(r.ventaId).toBe(999);
    expect(r.numero).toBe(47);
    expect(mockRpc).toHaveBeenCalledWith('fn_crear_pedido_menu_qr_comanda', {
      p_token: 'tok',
      p_items: [{ item_id: 10, cantidad: 2 }],
      p_idempotency_key: 'KEY-1',
      p_notas: null,
    });
  });

  it('getCatalogoPorToken devuelve array vacío en error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TOKEN_INVALIDO' } });
    const r = await getCatalogoPorToken('bad');
    expect(r.data).toEqual([]);
    expect(r.error).toBe('TOKEN_INVALIDO');
  });
});
