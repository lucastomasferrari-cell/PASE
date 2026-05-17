// Tests del idReconciliation — la pieza central de Fase 4.3.
//
// Validamos:
//   - reconcileFromServerResult kind='venta' mueve el row del tempId al realId
//   - cascada: items de esa venta actualizan su venta_id
//   - cascada: pagos de esa venta actualizan su venta_id
//   - cascada: pending_ops futuras que referenciaban tempId pasan a realId
//   - tempId positivo (BIGINT real) → no-op (idempotente)
//   - tempId no encontrado → no-op
//   - serverResult inválido → throw
//   - emite event `comanda:reconcile-id`

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileFromServerResult, listenReconcile } from '../idReconciliation';
import { ventasRepo, ventasItemsRepo, ventasPagosRepo } from '@/lib/db/repositories/ventasRepo';
import { enqueueOperation } from '../operations';
import { resetDb, _resetSingletonForTest, getDb } from '@/lib/db/index';
import type { LocalVentaPos, LocalVentaItem, LocalVentaPago, PendingOp } from '@/lib/db/schema';

function mkVenta(id: number, over: Partial<LocalVentaPos> = {}): LocalVentaPos {
  return {
    id, tenant_id: 'T', local_id: 1, canal_id: 1, numero_local: 0,
    mesa_id: null, modo: 'salon', estado: 'abierta', covers: 2,
    abierta_at: new Date().toISOString(),
    subtotal: 0, descuento_total: 0, propina: 0, total: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    ...over,
  } as unknown as LocalVentaPos;
}

function mkItem(id: number, ventaId: number): LocalVentaItem {
  return {
    id, tenant_id: 'T', local_id: 1, venta_id: ventaId, item_id: 100,
    cantidad: 1, precio_unitario: 500, subtotal: 500, descuento: 0,
    modificadores: null, curso: 1, combo_padre_id: null,
    es_combo_padre: false, estado: 'hold',
    enviado_at: null, listo_at: null, anulado_at: null, anulado_motivo: null,
    notas: null, cargado_por: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  } as unknown as LocalVentaItem;
}

function mkPago(id: number, ventaId: number): LocalVentaPago {
  return {
    id, tenant_id: 'T', local_id: 1, venta_id: ventaId,
    metodo: 'efectivo', monto: 500, idempotency_key: 'k1',
    vuelto: 0, propina_incluida: 0, cobrado_por: null,
    created_at: new Date().toISOString(),
  } as unknown as LocalVentaPago;
}

describe('sync/idReconciliation', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('venta: tempId negativo → BIGINT real (move row + cascada items + pagos)', async () => {
    const TEMP = -1000000001;
    const REAL = 5421;
    await ventasRepo.put(mkVenta(TEMP, { estado: 'abierta', total: 1500 }));
    await ventasItemsRepo.put(mkItem(-2, TEMP));
    await ventasItemsRepo.put(mkItem(-3, TEMP));
    await ventasItemsRepo.put(mkItem(-4, -999)); // de otra venta, NO debe tocar
    await ventasPagosRepo.put(mkPago(-5, TEMP));

    await reconcileFromServerResult(
      { kind: 'venta', tempVentaId: TEMP },
      REAL,
    );

    // Venta movida
    expect(await ventasRepo.getById(TEMP)).toBeUndefined();
    const real = await ventasRepo.getById(REAL);
    expect(real).toBeDefined();
    expect(real?.total).toBe(1500);
    expect((real as unknown as { _local_dirty?: boolean })._local_dirty).toBe(false);

    // Items de la venta migraron venta_id
    const itemsReal = await ventasItemsRepo.listByVenta(REAL);
    expect(itemsReal).toHaveLength(2);
    // Item de otra venta intacto
    const itemsOtra = await ventasItemsRepo.listByVenta(-999);
    expect(itemsOtra).toHaveLength(1);

    // Pago migró venta_id
    const pagosReal = await ventasPagosRepo.listByVenta(REAL);
    expect(pagosReal).toHaveLength(1);
  });

  it('venta: pending_ops futuras con p_venta_id=tempId pasan a realId', async () => {
    const TEMP = -1000000002;
    const REAL = 999;
    await ventasRepo.put(mkVenta(TEMP));

    // Op futura referenciando la venta temp
    const opId = await enqueueOperation({
      target: 'fn_mandar_curso_comanda',
      op_type: 'rpc',
      payload: { p_venta_id: TEMP, p_venta_idempotency_uuid: '__pending_parent__', p_curso: 1 },
    });

    await reconcileFromServerResult({ kind: 'venta', tempVentaId: TEMP }, REAL);

    const db = await getDb();
    const op = (await db.get('pending_ops', opId)) as PendingOp;
    const payload = op.payload as Record<string, unknown>;
    expect(payload.p_venta_id).toBe(REAL);
    expect(payload.p_venta_idempotency_uuid).toBeNull();
  });

  it('tempId positivo (era venta online) → no-op idempotente', async () => {
    const REAL_ID = 100;
    await ventasRepo.put(mkVenta(REAL_ID));
    await reconcileFromServerResult({ kind: 'venta', tempVentaId: REAL_ID }, 999);
    // Row original intacto, no se movió
    expect(await ventasRepo.getById(REAL_ID)).toBeDefined();
    expect(await ventasRepo.getById(999)).toBeUndefined();
  });

  it('tempId no encontrado → no rompe (idempotente)', async () => {
    await expect(
      reconcileFromServerResult({ kind: 'venta', tempVentaId: -9999 }, 100),
    ).resolves.toBeUndefined();
  });

  it('serverResult inválido (no es número ni string numérico) → throw', async () => {
    await expect(
      reconcileFromServerResult({ kind: 'venta', tempVentaId: -1 }, 'no-soy-numero'),
    ).rejects.toThrow(/no es BIGINT/);
  });

  it('serverResult como array [N] o {id: N} extrae correcto', async () => {
    const TEMP = -1000000003;
    await ventasRepo.put(mkVenta(TEMP));
    await reconcileFromServerResult({ kind: 'venta', tempVentaId: TEMP }, [777]);
    expect(await ventasRepo.getById(777)).toBeDefined();

    const TEMP2 = -1000000004;
    await ventasRepo.put(mkVenta(TEMP2));
    await reconcileFromServerResult({ kind: 'venta', tempVentaId: TEMP2 }, { id: 888 });
    expect(await ventasRepo.getById(888)).toBeDefined();
  });

  it('venta_item: tempId → realId', async () => {
    const TEMP = -1000000005;
    const REAL = 222;
    await ventasItemsRepo.put(mkItem(TEMP, 100));
    await reconcileFromServerResult({ kind: 'venta_item', tempItemId: TEMP, tempVentaId: null }, REAL);
    expect(await ventasItemsRepo.getById(TEMP)).toBeUndefined();
    expect(await ventasItemsRepo.getById(REAL)).toBeDefined();
  });

  it('event bus: emite comanda:reconcile-id con detail', async () => {
    const TEMP = -1000000006;
    const REAL = 333;
    await ventasRepo.put(mkVenta(TEMP));

    const handler = vi.fn();
    const cleanup = listenReconcile(handler);

    await reconcileFromServerResult({ kind: 'venta', tempVentaId: TEMP }, REAL);

    expect(handler).toHaveBeenCalledWith({ kind: 'venta', tempId: TEMP, realId: REAL });
    cleanup();
  });

  it('si ya existe row con realId, sacar la temp sin sobrescribir (retry/duplicate)', async () => {
    const TEMP = -1000000007;
    const REAL = 555;
    // El pull incremental ya trajo la venta real antes que el push reconciliara
    await ventasRepo.put(mkVenta(REAL, { total: 9999 })); // existente con valor distinto
    await ventasRepo.put(mkVenta(TEMP, { total: 100 })); // temp local

    await reconcileFromServerResult({ kind: 'venta', tempVentaId: TEMP }, REAL);

    const real = await ventasRepo.getById(REAL);
    expect(real?.total).toBe(9999); // no se sobrescribió con el temp
    expect(await ventasRepo.getById(TEMP)).toBeUndefined();
  });
});
