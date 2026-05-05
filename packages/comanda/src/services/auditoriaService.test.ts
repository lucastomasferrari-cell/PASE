import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { from: (...args: unknown[]) => mockFrom(...args), rpc: () => ({}) },
}));

import { listOverrides, getOverride } from './auditoriaService';

beforeEach(() => mockFrom.mockReset());

describe('listOverrides', () => {
  it('arma query con filtros', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const order = vi.fn().mockReturnValue({ limit });
    const lte = vi.fn().mockReturnValue({ order });
    const gte = vi.fn().mockReturnValue({ lte });
    const eq2 = vi.fn().mockReturnValue({ gte });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const eq0 = vi.fn().mockReturnValue({ eq: eq1 });
    const select = vi.fn().mockReturnValue({ eq: eq0 });
    mockFrom.mockReturnValue({ select });

    const desde = new Date('2026-05-01');
    const hasta = new Date('2026-05-07');
    await listOverrides({
      localId: 1,
      cajeroId: 'caj-uuid',
      accion: 'discount',
      desde,
      hasta,
      limit: 50,
    });
    expect(mockFrom).toHaveBeenCalledWith('ventas_pos_overrides');
    expect(select).toHaveBeenCalledWith('*');
    expect(eq0).toHaveBeenCalledWith('local_id', 1);
    expect(eq1).toHaveBeenCalledWith('cajero_id', 'caj-uuid');
    expect(eq2).toHaveBeenCalledWith('accion', 'discount');
    expect(gte).toHaveBeenCalledWith('created_at', desde.toISOString());
    expect(lte).toHaveBeenCalledWith('created_at', hasta.toISOString());
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(50);
  });
});

describe('getOverride', () => {
  it('devuelve el primer row', async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [{ id: 5, accion: 'void' }],
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });

    const r = await getOverride(5);
    expect(r.data).toMatchObject({ id: 5, accion: 'void' });
  });
});
