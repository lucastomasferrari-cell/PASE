import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBuilder = vi.fn();

vi.mock('../lib/supabase', () => ({
  db: {
    from: () => mockBuilder(),
  },
}));

import {
  createMetodo, updateMetodo, softDeleteMetodo, toggleActivo, setOrden,
  type MetodoDraft,
} from './metodosCobroService';

beforeEach(() => mockBuilder.mockReset());

const draftBase: MetodoDraft = {
  nombre: 'Mercado Pago',
  slug: 'mercadopago',
  emoji: '💸',
  pide_vuelto: false,
  es_efectivo: false,
  activo: true,
  orden: 1,
  tenant_id: 'tenant-uuid',
  local_id: null,
};

describe('createMetodo', () => {
  it('inserta y retorna id', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 7 }, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    mockBuilder.mockReturnValue({ insert });

    const res = await createMetodo(draftBase);
    expect(insert).toHaveBeenCalledWith(draftBase);
    expect(res.id).toBe(7);
  });
});

describe('updateMetodo', () => {
  it('aplica patch parcial', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });

    await updateMetodo(7, { nombre: 'MP Nuevo' });
    expect(update).toHaveBeenCalledWith({ nombre: 'MP Nuevo' });
    expect(eq).toHaveBeenCalledWith('id', 7);
  });
});

describe('toggleActivo', () => {
  it('habilita método', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await toggleActivo(7, true);
    expect(update).toHaveBeenCalledWith({ activo: true });
  });

  it('deshabilita método', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await toggleActivo(7, false);
    expect(update).toHaveBeenCalledWith({ activo: false });
  });
});

describe('setOrden', () => {
  it('cambia orden de un método', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });
    await setOrden(7, 5);
    expect(update).toHaveBeenCalledWith({ orden: 5 });
    expect(eq).toHaveBeenCalledWith('id', 7);
  });
});

describe('softDeleteMetodo', () => {
  it('setea deleted_at con timestamp ISO', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    mockBuilder.mockReturnValue({ update });

    await softDeleteMetodo(7);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
  });
});
