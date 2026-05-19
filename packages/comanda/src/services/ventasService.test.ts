import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({ eq: () => ({ is: () => ({ limit: () => ({ single: () => ({}) }) }) }) }),
    }),
  },
}));

// Estos tests validan la rama ONLINE de ventasService. La rama offline tiene
// su propio test suite (ventasOfflineService.test.ts). Fijamos el flag en
// false explícitamente para no depender del default global.
vi.mock('../lib/featureFlags', () => ({
  featureFlags: { offlineFirstVentas: false },
}));

import {
  abrirVenta, agregarItem, mandarCurso, anularItem, modificarItem,
} from './ventasService';

beforeEach(() => mockRpc.mockReset());

describe('abrirVenta', () => {
  it('pasa todos los args correctos', async () => {
    mockRpc.mockResolvedValue({ data: 100, error: null });
    const res = await abrirVenta({
      localId: 1, modo: 'salon', canalId: 5, mesaId: 10, mozoId: 'emp', covers: 4,
    });
    expect(mockRpc).toHaveBeenCalledWith('fn_abrir_venta_comanda', expect.objectContaining({
      p_local_id: 1, p_modo: 'salon', p_canal_id: 5, p_mesa_id: 10, p_mozo_id: 'emp', p_covers: 4,
      p_origen: 'pos', p_estado: 'abierta',
    }));
    expect(res.ventaId).toBe(100);
  });

  it('default origen=pos y estado=abierta cuando no se pasan', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await abrirVenta({ localId: 1, modo: 'mostrador', canalId: 1 });
    const callArgs = mockRpc.mock.calls[0]?.[1];
    expect(callArgs.p_origen).toBe('pos');
    expect(callArgs.p_estado).toBe('abierta');
  });
});

describe('agregarItem', () => {
  it('pasa modificadores como array y curso default 1', async () => {
    mockRpc.mockResolvedValue({ data: 5, error: null });
    const mods = [{ nombre: 'Jugoso', precio_extra: 0 }];
    await agregarItem({ ventaId: 1, itemId: 2, cantidad: 1, modificadores: mods });
    expect(mockRpc).toHaveBeenCalledWith('fn_agregar_item_comanda', expect.objectContaining({
      p_modificadores: mods, p_curso: 1,
    }));
  });
});

describe('mandarCurso', () => {
  it('retorna count de items afectados', async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null });
    const res = await mandarCurso(10, 1);
    expect(res.count).toBe(3);
    expect(res.error).toBeNull();
  });
  it('si data null, count=0', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const res = await mandarCurso(10, 1);
    expect(res.count).toBe(0);
  });
});

describe('anularItem requiere managerId', () => {
  it('lo pasa como p_manager_id', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await anularItem(50, 'mgr-uuid', 'cliente cambió de opinión');
    expect(mockRpc).toHaveBeenCalledWith('fn_anular_item_comanda', {
      p_item_id: 50, p_manager_id: 'mgr-uuid', p_motivo: 'cliente cambió de opinión',
      p_idempotency_key: null,
    });
  });
});

describe('modificarItem maneja null para no-cambios', () => {
  it('cantidad sola', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await modificarItem(1, { cantidad: 3 });
    expect(mockRpc).toHaveBeenCalledWith('fn_modificar_item_comanda', {
      p_item_id: 1, p_cantidad: 3, p_curso: null, p_notas: null,
    });
  });
});
