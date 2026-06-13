import { describe, it, expect, vi, beforeEach } from 'vitest';

// Valida la RAMA OFFLINE de agregarPago() en pagosService: cuando el flag
// offlineFirstVentas está ON, agregarPago debe delegar en agregarPagoOffline
// (encolar) en vez de pegarle directo a db.rpc. Vive en su propio file porque
// pagosService.test.ts fija el flag en false a nivel módulo (la rama online no
// puede tocar IndexedDB en jsdom).

const mockRpc = vi.fn();
vi.mock('./lib/supabase', () => ({
  db: { rpc: (...args: unknown[]) => mockRpc(...args), from: () => ({}) },
}));

// Flag ON → fuerza la rama offline.
vi.mock('./lib/featureFlags', () => ({
  featureFlags: { offlineFirstVentas: true },
}));

// La venta vive en el repo local (idb). Mockeamos para no depender de IndexedDB.
const fakeVenta = {
  id: -1234,
  tenant_id: 'T',
  local_id: 1,
  idempotency_uuid: 'venta-uuid-abc',
  _local_op_id: 'op-xyz',
  total: 1800,
  estado: 'abierta',
};
const mockGetById = vi.fn();
vi.mock('@/lib/db/repositories/ventasRepo', () => ({
  ventasRepo: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

// El offline service: queremos verificar que agregarPago lo invoca con los
// args derivados de la venta (UUID + opId) sin tocar la implementación real.
const mockAgregarPagoOffline = vi.fn();
vi.mock('./offline/pagosOfflineService', () => ({
  agregarPagoOffline: (...a: unknown[]) => mockAgregarPagoOffline(...a),
}));

import { agregarPago } from './pagosService';

beforeEach(() => {
  mockRpc.mockReset();
  mockGetById.mockReset();
  mockAgregarPagoOffline.mockReset();
});

describe('agregarPago — rama offline (flag ON)', () => {
  it('encola via agregarPagoOffline con UUID/opId de la venta, sin pegarle a db.rpc', async () => {
    mockGetById.mockResolvedValue({ ...fakeVenta });
    mockAgregarPagoOffline.mockResolvedValue({ tempPagoId: -9001, queuedOpId: 'q1' });

    const res = await agregarPago({
      ventaId: -1234,
      metodo: 'efectivo',
      monto: 1800,
      idempotencyKey: 'pago-k1',
      cobradoPor: 'emp-uuid',
    });

    // No fue por la rama online.
    expect(mockRpc).not.toHaveBeenCalled();
    // Delegó en el servicio offline con los args correctos.
    expect(mockAgregarPagoOffline).toHaveBeenCalledTimes(1);
    const arg = mockAgregarPagoOffline.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.ventaId).toBe(-1234);
    expect(arg.ventaUuid).toBe('venta-uuid-abc');
    expect(arg.ventaOpId).toBe('op-xyz');
    expect(arg.metodo).toBe('efectivo');
    expect(arg.monto).toBe(1800);
    expect(arg.idempotencyKey).toBe('pago-k1');
    expect(arg.tenantId).toBe('T');
    expect(arg.localId).toBe(1);
    // Devuelve el tempPagoId como pagoId.
    expect(res.pagoId).toBe(-9001);
    expect(res.error).toBeNull();
  });

  it('si la venta local no existe → VENTA_NO_ENCONTRADA, sin encolar', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await agregarPago({
      ventaId: -1234, metodo: 'efectivo', monto: 100, idempotencyKey: 'k',
    });
    expect(res.error).toBe('VENTA_NO_ENCONTRADA');
    expect(res.pagoId).toBeNull();
    expect(mockAgregarPagoOffline).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
