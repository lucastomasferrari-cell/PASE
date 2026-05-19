import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tests del mesasService — cubre operaciones críticas: transferir, unir,
// partir cuenta, y el CRUD básico. Mockea Supabase a nivel JS (no testea
// el SQL real — eso requiere DB e integration tests, anotado en deuda).

const mockRpc = vi.fn();
const mockBuilder = vi.fn();

vi.mock('../lib/supabase', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => mockBuilder(),
  },
}));

// Estos tests validan la rama ONLINE de mesasService. La rama offline tiene
// su propio test suite (transferenciasOfflineService). Fijamos el flag en
// false explícitamente para no depender del default global.
vi.mock('../lib/featureFlags', () => ({
  featureFlags: { offlineFirstVentas: false },
}));

import {
  transferirMesaService, unirMesasService, partirCuentaService,
  setMesaEstado,
} from './mesasService';

beforeEach(() => {
  mockRpc.mockReset();
  mockBuilder.mockReset();
});

describe('transferirMesaService', () => {
  it('llama fn_transferir_mesa_comanda con args correctos', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const res = await transferirMesaService(10, 5, 'mgr-uuid', 'cliente cambió de mesa');
    expect(mockRpc).toHaveBeenCalledWith('fn_transferir_mesa_comanda', {
      p_venta_id: 10,
      p_mesa_destino: 5,
      p_manager_id: 'mgr-uuid',
      p_motivo: 'cliente cambió de mesa',
    });
    expect(res.error).toBeNull();
  });

  it('mapea error MESA_DESTINO_OCUPADA', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'MESA_DESTINO_OCUPADA: la mesa 5 ya tiene una venta abierta' },
    });
    const res = await transferirMesaService(10, 5, 'mgr', 'cambio');
    expect(res.error).toContain('MESA_DESTINO_OCUPADA');
  });

  it('mapea error VENTA_NO_ENCONTRADA', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'VENTA_NO_ENCONTRADA' },
    });
    const res = await transferirMesaService(999, 5, 'mgr', 'x');
    expect(res.error).toBe('VENTA_NO_ENCONTRADA');
  });
});

describe('unirMesasService', () => {
  it('llama fn_unir_mesas_comanda con origen + destino', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await unirMesasService(7, 12, 'mgr', 'consolidación');
    expect(mockRpc).toHaveBeenCalledWith('fn_unir_mesas_comanda', {
      p_venta_origen_id: 7,
      p_venta_destino_id: 12,
      p_manager_id: 'mgr',
      p_motivo: 'consolidación',
    });
  });

  it('rechaza si una venta ya está cobrada', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'VENTA_YA_COBRADA: no se puede unir' },
    });
    const res = await unirMesasService(1, 2, 'mgr', 'x');
    expect(res.error).toContain('VENTA_YA_COBRADA');
  });
});

describe('partirCuentaService', () => {
  it('llama fn_partir_cuenta_comanda y retorna venta nueva', async () => {
    mockRpc.mockResolvedValue({ data: 99, error: null });
    const res = await partirCuentaService(10, [101, 102, 103], 'mgr', 'cliente paga aparte');
    expect(mockRpc).toHaveBeenCalledWith('fn_partir_cuenta_comanda', {
      p_venta_id: 10,
      p_item_ids: [101, 102, 103],
      p_manager_id: 'mgr',
      p_motivo: 'cliente paga aparte',
    });
    expect(res.ventaNuevaId).toBe(99);
    expect(res.error).toBeNull();
  });

  it('rechaza item_ids vacío', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ITEMS_REQUERIDOS: debe seleccionar al menos un item' },
    });
    const res = await partirCuentaService(10, [], 'mgr', 'x');
    expect(res.ventaNuevaId).toBeNull();
    // translateError mapea ITEMS_REQUERIDOS al mensaje en español
    expect(res.error).toMatch(/seleccionar.*item|item.*requerido/i);
  });

  it('mapea error VENTA_NO_EDITABLE', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'VENTA_NO_EDITABLE: estado cobrada' },
    });
    const res = await partirCuentaService(10, [1], 'mgr', 'x');
    expect(res.error).toMatch(/venta.*editar|no se puede editar/i);
  });
});

describe('setMesaEstado', () => {
  it('actualiza estado de mesa via builder', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    mockBuilder.mockReturnValue({ update: updateMock });
    const res = await setMesaEstado(5, 'libre');
    expect(updateMock).toHaveBeenCalledWith({ estado: 'libre' });
    expect(eqMock).toHaveBeenCalledWith('id', 5);
    expect(res.error).toBeNull();
  });

  it('mapea error de DB', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: { message: 'DB_ERROR' } });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    mockBuilder.mockReturnValue({ update: updateMock });
    const res = await setMesaEstado(5, 'ocupada');
    expect(res.error).toBe('DB_ERROR');
  });
});
