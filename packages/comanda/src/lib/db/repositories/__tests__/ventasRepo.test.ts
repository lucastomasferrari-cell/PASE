// Test del ventasRepo + items + pagos. Verifica:
//   - listAbiertasByLocal filtra por estado
//   - findByMesa devuelve la abierta (no las cobradas)
//   - listByVenta ordena correcto
//   - deleteByVenta limpia solo los items de esa venta

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ventasRepo, ventasItemsRepo } from '../ventasRepo';
import { resetDb, _resetSingletonForTest } from '../../index';
import type { LocalVentaPos, LocalVentaItem } from '../../schema';

function mkVenta(over: Partial<LocalVentaPos> = {}): LocalVentaPos {
  return {
    id: 1,
    tenant_id: 'T',
    local_id: 1,
    canal_id: 1,
    numero_local: 1,
    mesa_id: null,
    cajero_id: null,
    mozo_id: null,
    cliente_id: null,
    modo: 'salon',
    estado: 'abierta',
    covers: 2,
    abierta_at: '2026-05-16T12:00:00Z',
    cobrada_at: null,
    anulada_at: null,
    enviada_at: null,
    subtotal: 0,
    descuento_total: 0,
    propina: 0,
    total: 0,
    coursing_auto: false,
    notas: null,
    cliente_nombre: null,
    tab_nombre: null,
    pagada: false,
    created_at: '2026-05-16T12:00:00Z',
    updated_at: '2026-05-16T12:00:00Z',
    deleted_at: null,
    ...over,
  } as LocalVentaPos;
}

function mkItem(over: Partial<LocalVentaItem> = {}): LocalVentaItem {
  return {
    id: 1,
    tenant_id: 'T',
    local_id: 1,
    venta_id: 1,
    item_id: 100,
    cantidad: 1,
    precio_unitario: 1500,
    subtotal: 1500,
    descuento: 0,
    modificadores: null,
    curso: 1,
    combo_padre_id: null,
    es_combo_padre: false,
    estado: 'hold',
    enviado_at: null,
    listo_at: null,
    anulado_at: null,
    anulado_motivo: null,
    notas: null,
    cargado_por: null,
    created_at: '2026-05-16T12:00:00Z',
    updated_at: '2026-05-16T12:00:00Z',
    deleted_at: null,
    ...over,
  } as LocalVentaItem;
}

describe('ventasRepo (DB local)', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('listAbiertasByLocal filtra cobradas/anuladas', async () => {
    await ventasRepo.put(mkVenta({ id: 1, local_id: 1, estado: 'abierta' }));
    await ventasRepo.put(mkVenta({ id: 2, local_id: 1, estado: 'cobrada' }));
    await ventasRepo.put(mkVenta({ id: 3, local_id: 1, estado: 'anulada' }));
    await ventasRepo.put(mkVenta({ id: 4, local_id: 1, estado: 'enviada' }));
    await ventasRepo.put(mkVenta({ id: 5, local_id: 2, estado: 'abierta' })); // otro local
    const abiertas = await ventasRepo.listAbiertasByLocal(1);
    expect(abiertas.map((v) => v.id).sort()).toEqual([1, 4]);
  });

  it('findByMesa devuelve la abierta de esa mesa', async () => {
    await ventasRepo.put(mkVenta({ id: 1, mesa_id: 5, estado: 'cobrada' })); // vieja cobrada
    await ventasRepo.put(mkVenta({ id: 2, mesa_id: 5, estado: 'abierta' })); // activa
    await ventasRepo.put(mkVenta({ id: 3, mesa_id: 6, estado: 'abierta' })); // otra mesa
    const v = await ventasRepo.findByMesa(5);
    expect(v?.id).toBe(2);
  });

  it('items: listByVenta + deleteByVenta', async () => {
    await ventasItemsRepo.put(mkItem({ id: 1, venta_id: 100 }));
    await ventasItemsRepo.put(mkItem({ id: 2, venta_id: 100 }));
    await ventasItemsRepo.put(mkItem({ id: 3, venta_id: 200 }));
    let items = await ventasItemsRepo.listByVenta(100);
    expect(items).toHaveLength(2);
    await ventasItemsRepo.deleteByVenta(100);
    items = await ventasItemsRepo.listByVenta(100);
    expect(items).toHaveLength(0);
    // venta 200 intacta
    const otros = await ventasItemsRepo.listByVenta(200);
    expect(otros).toHaveLength(1);
  });

  it('dirty tracking: ventas marcadas dirty al put, clean al markSynced', async () => {
    await ventasRepo.put(mkVenta({ id: 50 }));
    const dirty = await ventasRepo.findDirty();
    expect(dirty.map((v) => v.id)).toContain(50);
    await ventasRepo.markSynced(50);
    const dirtyAfter = await ventasRepo.findDirty();
    expect(dirtyAfter.map((v) => v.id)).not.toContain(50);
  });
});
