import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBuilder = vi.fn();

vi.mock('../lib/supabase', () => ({
  db: {
    from: () => mockBuilder(),
  },
}));

import {
  createGrupo, updateGrupo, softDeleteGrupo,
  type GrupoDraft,
} from './gruposService';

beforeEach(() => mockBuilder.mockReset());

const draftBase: GrupoDraft = {
  nombre: 'Bebidas',
  color: '#a8893a',
  color_ramp: 'amber',
  emoji: '🥤',
  orden: 1,
  tax_rate_id: null,
  estacion_default: null,
  tenant_id: 'tenant-uuid',
  local_id: null,
};

describe('createGrupo', () => {
  it('inserta grupo y retorna id', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 42 }, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    mockBuilder.mockReturnValue({ insert });

    const res = await createGrupo(draftBase);
    expect(insert).toHaveBeenCalledWith(draftBase);
    expect(res.id).toBe(42);
    expect(res.error).toBeNull();
  });

  it('mapea error de DB', async () => {
    const single = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'duplicate key value violates unique constraint' },
    });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    mockBuilder.mockReturnValue({ insert });

    const res = await createGrupo(draftBase);
    expect(res.id).toBeNull();
    expect(res.error).toContain('duplicate');
  });

  it('acepta los 8 color_ramp válidos', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    mockBuilder.mockReturnValue({ insert });

    const ramps = ['amber', 'pink', 'purple', 'blue', 'coral', 'teal', 'green', 'gray'] as const;
    for (const ramp of ramps) {
      await createGrupo({ ...draftBase, color_ramp: ramp });
    }
    expect(insert).toHaveBeenCalledTimes(8);
  });
});

describe('updateGrupo', () => {
  it('actualiza solo los campos del patch', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });

    await updateGrupo(5, { color_ramp: 'pink' });
    expect(update).toHaveBeenCalledWith({ color_ramp: 'pink' });
    expect(eq).toHaveBeenCalledWith('id', 5);
  });
});

describe('softDeleteGrupo', () => {
  it('rechaza si el grupo tiene items asignados', async () => {
    // Setup: count devuelve 3 items
    const isCountFn = vi.fn().mockResolvedValue({ count: 3, error: null });
    const eqCount = vi.fn().mockReturnValue({ is: isCountFn });
    const selectCount = vi.fn().mockReturnValue({ eq: eqCount });
    mockBuilder.mockReturnValueOnce({ select: selectCount });

    const res = await softDeleteGrupo(5);
    expect(res.error).toContain('3 item(s) asignado');
  });

  it('borrado lógico (deleted_at) cuando no tiene items', async () => {
    // Primer .from(): count = 0
    const isCountFn = vi.fn().mockResolvedValue({ count: 0, error: null });
    const eqCount = vi.fn().mockReturnValue({ is: isCountFn });
    const selectCount = vi.fn().mockReturnValue({ eq: eqCount });
    mockBuilder.mockReturnValueOnce({ select: selectCount });

    // Segundo .from(): update deleted_at
    const eqUpdate = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: eqUpdate });
    mockBuilder.mockReturnValueOnce({ update });

    const res = await softDeleteGrupo(5);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
    expect(res.error).toBeNull();
  });

  it('mapea error de count query', async () => {
    const isCountFn = vi.fn().mockResolvedValue({
      count: null,
      error: { message: 'DB_ERROR' },
    });
    const eqCount = vi.fn().mockReturnValue({ is: isCountFn });
    const selectCount = vi.fn().mockReturnValue({ eq: eqCount });
    mockBuilder.mockReturnValueOnce({ select: selectCount });

    const res = await softDeleteGrupo(5);
    expect(res.error).toBe('DB_ERROR');
  });
});
