import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../lib/supabaseAnon', () => ({
  dbAnon: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

import { getTickets, marcarListo, recall } from './kdsService';

beforeEach(() => mockRpc.mockReset());

describe('kdsService', () => {
  it('getTickets pasa el token a la RPC', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getTickets('tok-abc');
    expect(mockRpc).toHaveBeenCalledWith('fn_kds_get_tickets_comanda', { p_token: 'tok-abc' });
  });

  it('marcarListo pasa token + item_id', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await marcarListo('tok', 42);
    expect(mockRpc).toHaveBeenCalledWith('fn_kds_marcar_listo_comanda', { p_token: 'tok', p_item_id: 42 });
  });

  it('recall pasa token + item_id', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await recall('tok', 7);
    expect(mockRpc).toHaveBeenCalledWith('fn_kds_recall_comanda', { p_token: 'tok', p_item_id: 7 });
  });

  it('propaga el error de la RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TOKEN_INVALIDO' } });
    const r = await getTickets('bad');
    // translateError convierte TOKEN_INVALIDO al mensaje en español
    expect(r.error).toMatch(/token.*inv[áa]lido/i);
    expect(r.data).toEqual([]);
  });
});
