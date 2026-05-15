import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import { listInsumos, getInsumo, createInsumo, updateInsumo, softDeleteInsumo } from './insumosService';

beforeEach(() => { mockFrom.mockReset(); });

describe('listInsumos', () => {
  it('default: deleted_at IS NULL + activo=true + order nombre asc', async () => {
    const limitFn = vi.fn().mockReturnValue({});
    const eqFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn, eq: eqFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    // Como onlyActivos=true es default y agrega .eq al final del chain,
    // hacemos que limit retorne un objeto encadenable.
    limitFn.mockReturnValue({ eq: eqFn });

    await listInsumos();

    expect(mockFrom).toHaveBeenCalledWith('insumos');
    expect(isFn).toHaveBeenCalledWith('deleted_at', null);
    expect(eqFn).toHaveBeenCalledWith('activo', true);
  });

  it('search agrega ilike', async () => {
    const ilikeFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqFn = vi.fn().mockReturnValue({ ilike: ilikeFn });
    const limitFn = vi.fn().mockReturnValue({ eq: eqFn });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const isFn = vi.fn().mockReturnValue({ order: orderFn });
    const select = vi.fn().mockReturnValue({ is: isFn });
    mockFrom.mockReturnValue({ select });

    await listInsumos({ search: 'tomate' });
    expect(ilikeFn).toHaveBeenCalledWith('nombre', '%tomate%');
  });
});

describe('createInsumo', () => {
  it('inserta con tenant_id + costo_actualizado_at si trae costo_actual', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const insertFn = vi.fn().mockReturnValue({ select: selectFn });
    mockFrom.mockReturnValue({ insert: insertFn });

    await createInsumo('tenant-uuid', {
      nombre: 'Tomate', unidad: 'kg', costo_actual: 1500,
    });
    const arg = insertFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.tenant_id).toBe('tenant-uuid');
    expect(arg.nombre).toBe('Tomate');
    expect(arg.unidad).toBe('kg');
    expect(arg.costo_actual).toBe(1500);
    expect(arg.costo_actualizado_at).toBeDefined();
  });

  it('no setea costo_actualizado_at si no viene costo_actual', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const insertFn = vi.fn().mockReturnValue({ select: selectFn });
    mockFrom.mockReturnValue({ insert: insertFn });

    await createInsumo('tenant-uuid', { nombre: 'X', unidad: 'un' });
    const arg = insertFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.costo_actualizado_at).toBeUndefined();
  });
});

describe('updateInsumo', () => {
  it('setea costo_actualizado_at si actualiza costo_actual', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const eqFn = vi.fn().mockReturnValue({ select: selectFn });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ update: updateFn });

    await updateInsumo(1, { costo_actual: 2000 });
    const arg = updateFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.costo_actual).toBe(2000);
    expect(arg.costo_actualizado_at).toBeDefined();
  });

  it('no setea costo_actualizado_at si solo cambia nombre', async () => {
    const singleFn = vi.fn().mockResolvedValue({ data: { id: 1 }, error: null });
    const selectFn = vi.fn().mockReturnValue({ single: singleFn });
    const eqFn = vi.fn().mockReturnValue({ select: selectFn });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ update: updateFn });

    await updateInsumo(1, { nombre: 'Nuevo nombre' });
    const arg = updateFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.costo_actualizado_at).toBeUndefined();
  });
});

describe('softDeleteInsumo', () => {
  it('hace update con deleted_at NOW', async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ update: updateFn });
    await softDeleteInsumo(42);
    const arg = updateFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.deleted_at).toBeDefined();
    expect(eqFn).toHaveBeenCalledWith('id', 42);
  });
});

describe('getInsumo', () => {
  it('select * where id + deleted_at IS NULL + maybeSingle', async () => {
    const maybe = vi.fn().mockResolvedValue({ data: { id: 1, nombre: 'X' }, error: null });
    const isFn = vi.fn().mockReturnValue({ maybeSingle: maybe });
    const eqFn = vi.fn().mockReturnValue({ is: isFn });
    const select = vi.fn().mockReturnValue({ eq: eqFn });
    mockFrom.mockReturnValue({ select });
    await getInsumo(1);
    expect(eqFn).toHaveBeenCalledWith('id', 1);
    expect(isFn).toHaveBeenCalledWith('deleted_at', null);
  });
});
