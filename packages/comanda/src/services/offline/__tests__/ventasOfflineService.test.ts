// Tests del ventasOfflineService. Validamos que:
//   - abrirVentaOffline crea row local + encola op + retorna tempId negativo
//   - agregarItemOffline crea item local + actualiza total venta + encola
//   - mandarCursoOffline cambia estado local de items
//   - tempIds son siempre negativos (no colisionan con BIGINT real)
//   - idempotency_uuid es UUID v4 válido

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abrirVentaOffline, agregarItemOffline, mandarCursoOffline,
  ventaHasPendingSync,
} from '../ventasOfflineService';
import { ventasRepo, ventasItemsRepo } from '@/lib/db/repositories/ventasRepo';
import { listPendingOps } from '@/lib/sync/operations';
import { resetDb, _resetSingletonForTest } from '@/lib/db/index';
import { syncEngine } from '@/lib/sync/syncEngine';

// Mock syncEngine.triggerPush para que no intente pegar a Supabase real
// durante el test (el syncEngine es singleton + import side-effect).
vi.spyOn(syncEngine, 'triggerPush').mockImplementation(async () => {});

describe('ventasOfflineService', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('abrirVentaOffline crea venta local con tempId negativo + encola RPC', async () => {
    const result = await abrirVentaOffline({
      tenantId: 'T',
      localId: 1,
      canalId: 2,
      modo: 'salon',
      mesaId: 5,
      mozoId: 'mozo-uuid',
      cajeroId: 'cajero-uuid',
      covers: 2,
    });

    expect(result.tempVentaId).toBeLessThan(0);
    expect(result.idempotencyUuid).toMatch(/^[0-9a-f]{8}-/);
    expect(result.queuedOpId).toBeTruthy();

    const venta = await ventasRepo.getById(result.tempVentaId);
    expect(venta).toBeDefined();
    expect(venta?.estado).toBe('abierta');
    expect(venta?.mesa_id).toBe(5);
    expect(venta?.covers).toBe(2);

    const ops = await listPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.target).toBe('fn_abrir_venta_comanda');
    expect((ops[0]!.payload as Record<string, unknown>).p_idempotency_uuid).toBe(result.idempotencyUuid);
  });

  it('agregarItemOffline crea item + actualiza total + encola', async () => {
    const { tempVentaId } = await abrirVentaOffline({
      tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
    });
    const itemRes = await agregarItemOffline({
      ventaId: tempVentaId,
      itemId: 100,
      cantidad: 2,
      precioUnitario: 1500,
      curso: 1,
      tenantId: 'T',
      localId: 1,
    });
    expect(itemRes.tempItemId).toBeLessThan(0);

    const items = await ventasItemsRepo.listByVenta(tempVentaId);
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.subtotal)).toBe(3000);

    const venta = await ventasRepo.getById(tempVentaId);
    expect(Number(venta?.total)).toBe(3000);

    const ops = await listPendingOps();
    expect(ops).toHaveLength(2);
    expect(ops[1]!.target).toBe('fn_agregar_item_comanda');
  });

  it('mandarCursoOffline cambia hold → enviado solo en items sin stay', async () => {
    const { tempVentaId } = await abrirVentaOffline({
      tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
    });
    // Item normal en hold curso 1
    await agregarItemOffline({
      ventaId: tempVentaId, itemId: 100, cantidad: 1,
      precioUnitario: 500, curso: 1, tenantId: 'T', localId: 1,
    });
    // Item con stay = no debe enviarse
    const stayItem = await agregarItemOffline({
      ventaId: tempVentaId, itemId: 101, cantidad: 1,
      precioUnitario: 800, curso: 1, tenantId: 'T', localId: 1,
    });
    const it = await ventasItemsRepo.getById(stayItem.tempItemId);
    if (it) {
      (it as unknown as { stay_until_release?: boolean }).stay_until_release = true;
      await ventasItemsRepo.put(it);
    }

    const res = await mandarCursoOffline(tempVentaId, 1);
    expect(res.count).toBe(1); // solo el no-stay

    const allItems = await ventasItemsRepo.listByVenta(tempVentaId);
    const enviados = allItems.filter((i) => i.estado === 'enviado');
    const enHold = allItems.filter((i) => i.estado === 'hold');
    expect(enviados).toHaveLength(1);
    expect(enHold).toHaveLength(1);
    expect(enHold[0]!.item_id).toBe(101); // el que tenía stay
  });

  it('tempIds nunca colisionan + son siempre negativos', async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const r = await abrirVentaOffline({
        tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
      });
      expect(r.tempVentaId).toBeLessThan(0);
      expect(ids.has(r.tempVentaId)).toBe(false);
      ids.add(r.tempVentaId);
    }
    expect(ids.size).toBe(10);
  });

  it('ventaHasPendingSync detecta ventas con cambios sin sync', async () => {
    const { tempVentaId } = await abrirVentaOffline({
      tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
    });
    expect(await ventaHasPendingSync(tempVentaId)).toBe(true);
    // Limpiar dirty manualmente (simulando sync)
    await ventasRepo.markSynced(tempVentaId);
    expect(await ventaHasPendingSync(tempVentaId)).toBe(false);
    // Agregar item dirty → vuelve a pending
    await agregarItemOffline({
      ventaId: tempVentaId, itemId: 200, cantidad: 1,
      precioUnitario: 100, tenantId: 'T', localId: 1,
    });
    // El agregar marca dirty la venta también por el update de total
    expect(await ventaHasPendingSync(tempVentaId)).toBe(true);
  });

  it('depends_on encadena items con venta cuando ambas son tempIds', async () => {
    const { tempVentaId, queuedOpId: ventaOpId } = await abrirVentaOffline({
      tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
    });
    await agregarItemOffline({
      ventaId: tempVentaId, itemId: 100, cantidad: 1,
      precioUnitario: 500, tenantId: 'T', localId: 1,
    });
    const ops = await listPendingOps();
    // Encontrar la op del item (no asumir orden — created_at puede coincidir
    // si están en el mismo ms).
    const itemOp = ops.find((o) => o.target === 'fn_agregar_item_comanda');
    const ventaOp = ops.find((o) => o.id === ventaOpId);
    expect(ventaOp).toBeDefined();
    expect(itemOp).toBeDefined();
    // El payload del item lleva p_venta_idempotency_uuid='__pending_parent__'
    // indicando que necesita la venta primero.
    expect((itemOp!.payload as Record<string, unknown>).p_venta_idempotency_uuid)
      .toBe('__pending_parent__');
  });
});
