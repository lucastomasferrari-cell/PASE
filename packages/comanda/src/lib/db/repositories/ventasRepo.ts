// Repository de ventas_pos + items + pagos.
// Refactor 2026-05-19: sin herencia de clase para evitar bug "Class
// extends value undefined" con code splitting agresivo de rolldown.

import * as base from './base';
import type { LocalVentaPos, LocalVentaItem, LocalVentaPago } from '../schema';

const ABIERTA_STATES = new Set(['abierta', 'enviada', 'lista', 'entregada']);

export const ventasRepo = {
  getById: (id: number) => base.getById<'ventas_pos'>('ventas_pos', id),
  getAll: () => base.getAll<'ventas_pos'>('ventas_pos'),
  count: () => base.count('ventas_pos'),
  put: (row: LocalVentaPos, opts?: base.PutOptions) => base.put<'ventas_pos'>('ventas_pos', row, opts),
  putMany: (rows: LocalVentaPos[], opts?: base.PutOptions) => base.putMany<'ventas_pos'>('ventas_pos', rows, opts),
  delete: (id: number) => base.deleteById('ventas_pos', id),
  clear: () => base.clearStore('ventas_pos'),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'ventas_pos'>('ventas_pos', indexName, value),
  findDirty: () => base.findDirty<'ventas_pos'>('ventas_pos'),
  markSynced: (id: number) => base.markSynced<'ventas_pos'>('ventas_pos', id),

  async listByLocal(localId: number, opts: { soloAbiertas?: boolean } = {}): Promise<LocalVentaPos[]> {
    const all = await base.findByIndex<'ventas_pos'>('ventas_pos', 'by_local', localId);
    let filtered = all.filter((v) => !v.deleted_at);
    if (opts.soloAbiertas) filtered = filtered.filter((v) => ABIERTA_STATES.has(v.estado));
    return filtered.sort((a, b) => {
      const da = a.abierta_at ?? '';
      const db = b.abierta_at ?? '';
      return db.localeCompare(da);
    });
  },

  async listAbiertasByLocal(localId: number): Promise<LocalVentaPos[]> {
    return this.listByLocal(localId, { soloAbiertas: true });
  },

  async findByMesa(mesaId: number): Promise<LocalVentaPos | undefined> {
    const all = await base.findByIndex<'ventas_pos'>('ventas_pos', 'by_mesa', mesaId);
    return all.find((v) => !v.deleted_at && ABIERTA_STATES.has(v.estado));
  },
};

export const ventasItemsRepo = {
  getById: (id: number) => base.getById<'ventas_pos_items'>('ventas_pos_items', id),
  put: (row: LocalVentaItem, opts?: base.PutOptions) => base.put<'ventas_pos_items'>('ventas_pos_items', row, opts),
  putMany: (rows: LocalVentaItem[], opts?: base.PutOptions) => base.putMany<'ventas_pos_items'>('ventas_pos_items', rows, opts),
  delete: (id: number) => base.deleteById('ventas_pos_items', id),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'ventas_pos_items'>('ventas_pos_items', indexName, value),
  findDirty: () => base.findDirty<'ventas_pos_items'>('ventas_pos_items'),
  markSynced: (id: number) => base.markSynced<'ventas_pos_items'>('ventas_pos_items', id),

  async listByVenta(ventaId: number): Promise<LocalVentaItem[]> {
    const all = await base.findByIndex<'ventas_pos_items'>('ventas_pos_items', 'by_venta', ventaId);
    return all.filter((i) => !i.deleted_at).sort((a, b) => a.id - b.id);
  },

  async deleteByVenta(ventaId: number): Promise<void> {
    const db = await base.getDb();
    const tx = db.transaction('ventas_pos_items', 'readwrite');
    const index = tx.store.index('by_venta');
    let cursor = await index.openCursor(ventaId);
    while (cursor) {
      await cursor!.delete();
      cursor = await cursor!.continue();
    }
    await tx.done;
  },
};

export const ventasPagosRepo = {
  put: (row: LocalVentaPago, opts?: base.PutOptions) => base.put<'ventas_pos_pagos'>('ventas_pos_pagos', row, opts),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'ventas_pos_pagos'>('ventas_pos_pagos', indexName, value),

  async listByVenta(ventaId: number): Promise<LocalVentaPago[]> {
    return base.findByIndex<'ventas_pos_pagos'>('ventas_pos_pagos', 'by_venta', ventaId);
  },
};
