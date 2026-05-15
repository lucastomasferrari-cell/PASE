import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import {
  listClientes, getCliente, createCliente, updateCliente, softDeleteCliente,
} from './clientesService';

beforeEach(() => { mockFrom.mockReset(); });

describe('listClientes', () => {
  it('llama from(clientes) con filtros deleted_at IS NULL + order + limit default', async () => {
    const limitFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    await listClientes();

    expect(mockFrom).toHaveBeenCalledWith('clientes');
    expect(isFn).toHaveBeenCalledWith('deleted_at', null);
    expect(orderFn).toHaveBeenCalledWith('ultimo_pedido_at', { ascending: false, nullsFirst: false });
    expect(limitFn).toHaveBeenCalledWith(100);
  });

  it('agrega filtro .or(...) si hay search', async () => {
    const orFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const limitFn = vi.fn().mockReturnValue({ or: orFn });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    await listClientes({ search: 'pepe' });

    expect(orFn).toHaveBeenCalledWith(
      'telefono.ilike.%pepe%,nombre.ilike.%pepe%,apellido.ilike.%pepe%'
    );
  });

  it('agrega filtro .eq(vip, true) si onlyVip', async () => {
    const eqFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const limitFn = vi.fn().mockReturnValue({ eq: eqFn });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    await listClientes({ onlyVip: true });

    expect(eqFn).toHaveBeenCalledWith('vip', true);
  });

  it('devuelve error si Supabase devuelve error', async () => {
    const limitFn = vi.fn().mockResolvedValue({ data: null, error: { message: 'RLS bloqueó' } });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    const r = await listClientes();
    expect(r.error).toBe('RLS bloqueó');
    expect(r.data).toEqual([]);
  });
});

describe('createCliente', () => {
  it('insert con tenant_id + input + select single', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1, telefono: '+5491112345678' }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const insertFn = vi.fn().mockReturnValue({ select: selectFn });
    mockFrom.mockReturnValue({ insert: insertFn });

    const r = await createCliente('tenant-uuid', { telefono: '+5491112345678', nombre: 'Pepe' });
    expect(insertFn).toHaveBeenCalledWith({ tenant_id: 'tenant-uuid', telefono: '+5491112345678', nombre: 'Pepe' });
    expect(selectFn).toHaveBeenCalledWith('*');
    expect(r.data?.id).toBe(1);
  });
});

describe('softDeleteCliente', () => {
  it('hace update con deleted_at NOW + eq id', async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ update: updateFn });

    await softDeleteCliente(42);
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
    expect(eqFn).toHaveBeenCalledWith('id', 42);
  });
});

describe('getCliente', () => {
  it('select * from clientes where id + deleted_at IS NULL', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 1, telefono: 'X' }, error: null });
    const isFn = vi.fn().mockReturnValue({ maybeSingle });
    const eqFn = vi.fn().mockReturnValue({ is: isFn });
    const select = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ select });

    await getCliente(1);
    expect(eqFn).toHaveBeenCalledWith('id', 1);
    expect(isFn).toHaveBeenCalledWith('deleted_at', null);
  });
});

describe('updateCliente', () => {
  it('update + eq + select * single', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1, nombre: 'Nuevo' }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const eqFn = vi.fn().mockReturnValue({ select: selectFn });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ update: updateFn });

    await updateCliente(1, { nombre: 'Nuevo' });
    expect(updateFn).toHaveBeenCalledWith({ nombre: 'Nuevo' });
    expect(eqFn).toHaveBeenCalledWith('id', 1);
  });
});
