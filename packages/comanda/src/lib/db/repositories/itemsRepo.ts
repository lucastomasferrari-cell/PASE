// Repository de items (catálogo del POS) en DB local.
//
// Refactor 2026-05-19: NO usa herencia de clase para evitar el bug
// "Class extends value undefined" cuando rolldown hace code splitting.
// En vez de eso, expone un objeto con funciones que componen las
// operaciones genéricas de ./base.

import * as base from './base';
import type { LocalItem } from '../schema';

export interface ListItemsOpts {
  grupoId?: number;
  soloVisiblesPos?: boolean;
  soloDisponibles?: boolean;
}

export const itemsRepo = {
  getById: (id: number) => base.getById<'items'>('items', id),
  getAll: () => base.getAll<'items'>('items'),
  count: () => base.count('items'),
  put: (row: LocalItem, opts?: base.PutOptions) => base.put<'items'>('items', row, opts),
  putMany: (rows: LocalItem[], opts?: base.PutOptions) => base.putMany<'items'>('items', rows, opts),
  delete: (id: number) => base.deleteById('items', id),
  clear: () => base.clearStore('items'),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'items'>('items', indexName, value),
  findDirty: () => base.findDirty<'items'>('items'),
  markSynced: (id: number) => base.markSynced<'items'>('items', id),

  // Listar items del tenant ordenados por orden + id. Filtros opcionales
  // por grupo y por estado. La UI hace filtrado adicional in-memory por
  // search text para evitar cursors.
  async listByTenant(tenantId: string, opts: ListItemsOpts = {}): Promise<LocalItem[]> {
    const all = await base.findByIndex<'items'>('items', 'by_tenant', tenantId);
    let filtered = all;
    if (opts.grupoId != null) filtered = filtered.filter((i) => i.grupo_id === opts.grupoId);
    if (opts.soloVisiblesPos) filtered = filtered.filter((i) => i.visible_pos);
    if (opts.soloDisponibles) filtered = filtered.filter((i) => i.estado === 'disponible');
    filtered = filtered.filter((i) => !i.deleted_at);
    return filtered.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id);
  },

  // Reemplaza el catálogo entero del tenant. Usado por pullInitial.
  async replaceForTenant(tenantId: string, rows: LocalItem[]): Promise<void> {
    const db = await base.getDb();
    const tx = db.transaction('items', 'readwrite');
    const index = tx.store.index('by_tenant');
    let cursor = await index.openCursor(IDBKeyRange.only(tenantId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    for (const r of rows) {
      await tx.store.put({ ...r, _local_dirty: false, _local_synced_at: new Date().toISOString() });
    }
    await tx.done;
  },
};
