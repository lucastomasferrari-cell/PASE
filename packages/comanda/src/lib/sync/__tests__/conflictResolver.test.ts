// Tests del LWW conflict resolver.
//
// Casos:
//   - cloud más nuevo + local clean → cloud_wins
//   - cloud más nuevo + local dirty → cloud_wins (loguea conflicto)
//   - local más nuevo + dirty → local_wins
//   - venta cobrada local + cloud abierta → manual_pending (protección final)
//   - venta cobrada local + cloud cobrada → local_wins (mismo estado, no conflicto)

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveLWW, logConflict, listPendingConflicts } from '../conflictResolver';
import { resetDb, _resetSingletonForTest } from '../../db/index';
import type { LocalVentaPos, LocalItem, LocalMeta } from '../../db/schema';

function localItem(over: Partial<LocalItem & LocalMeta> = {}): LocalItem {
  return {
    id: 1, tenant_id: 'T', local_id: 1, nombre: 'X',
    grupo_id: 1, orden: 0, precio_madre: 100, costo_actual: 50,
    tax_rate_id: null, estacion: null, estado: 'disponible',
    visible_pos: true, visible_qr: true, visible_tienda: true,
    es_combo: false, es_open_item: false,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
    deleted_at: null,
    _local_dirty: false,
    ...over,
  } as unknown as LocalItem;
}

function localVenta(over: Partial<LocalVentaPos & LocalMeta> = {}): LocalVentaPos {
  return {
    id: 1, tenant_id: 'T', local_id: 1, canal_id: 1,
    numero_local: 1, mesa_id: null,
    modo: 'salon', estado: 'abierta', covers: 2,
    abierta_at: '2026-05-16T12:00:00Z',
    subtotal: 0, descuento_total: 0, propina: 0, total: 0,
    created_at: '2026-05-16T12:00:00Z',
    updated_at: '2026-05-16T12:00:00Z',
    deleted_at: null,
    _local_dirty: false,
    ...over,
  } as unknown as LocalVentaPos;
}

describe('sync/conflictResolver — resolveLWW', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('cloud más nuevo + local clean → cloud_wins', () => {
    const local = localItem({ updated_at: '2026-05-16T12:00:00Z', _local_dirty: false });
    const cloud = localItem({ updated_at: '2026-05-16T12:30:00Z' });
    expect(resolveLWW(local, cloud, { store: 'items', rowId: 1 })).toBe('cloud_wins');
  });

  it('cloud más nuevo + local dirty → cloud_wins (igual gana cloud porque ts mayor)', () => {
    const local = localItem({ updated_at: '2026-05-16T12:00:00Z', _local_dirty: true });
    const cloud = localItem({ updated_at: '2026-05-16T12:30:00Z' });
    expect(resolveLWW(local, cloud, { store: 'items', rowId: 1 })).toBe('cloud_wins');
  });

  it('local más nuevo + dirty → local_wins', () => {
    const local = localItem({ updated_at: '2026-05-16T13:00:00Z', _local_dirty: true });
    const cloud = localItem({ updated_at: '2026-05-16T12:30:00Z' });
    expect(resolveLWW(local, cloud, { store: 'items', rowId: 1 })).toBe('local_wins');
  });

  it('local más nuevo + clean → cloud_wins (sin dirty no defendemos)', () => {
    const local = localItem({ updated_at: '2026-05-16T13:00:00Z', _local_dirty: false });
    const cloud = localItem({ updated_at: '2026-05-16T12:30:00Z' });
    expect(resolveLWW(local, cloud, { store: 'items', rowId: 1 })).toBe('cloud_wins');
  });

  it('protección: venta cobrada local + cloud abierta → manual_pending', () => {
    const local = localVenta({ estado: 'cobrada' });
    const cloud = localVenta({ estado: 'abierta', updated_at: '2026-05-16T13:00:00Z' });
    expect(resolveLWW(local, cloud, { store: 'ventas_pos', rowId: 1 })).toBe('manual_pending');
  });

  it('protección: venta cobrada local + cloud cobrada → local_wins (mismo estado)', () => {
    const local = localVenta({ estado: 'cobrada' });
    const cloud = localVenta({ estado: 'cobrada', updated_at: '2026-05-16T13:00:00Z' });
    expect(resolveLWW(local, cloud, { store: 'ventas_pos', rowId: 1 })).toBe('local_wins');
  });

  it('protección: venta anulada local + cloud abierta → manual_pending', () => {
    const local = localVenta({ estado: 'anulada' });
    const cloud = localVenta({ estado: 'abierta', updated_at: '2026-05-16T13:00:00Z' });
    expect(resolveLWW(local, cloud, { store: 'ventas_pos', rowId: 1 })).toBe('manual_pending');
  });
});

describe('sync/conflictResolver — logConflict + listPendingConflicts', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('logConflict persiste + listPendingConflicts filtra solo pendientes', async () => {
    await logConflict({
      store: 'items', rowId: 1,
      localValue: { v: 'local' }, cloudValue: { v: 'cloud' },
      resolution: 'manual_pending',
    });
    await logConflict({
      store: 'items', rowId: 2,
      localValue: { v: 'local' }, cloudValue: { v: 'cloud' },
      resolution: 'local_wins', // auto resuelto, no es manual_pending
    });
    const pending = await listPendingConflicts();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.row_id).toBe('1');
  });
});
