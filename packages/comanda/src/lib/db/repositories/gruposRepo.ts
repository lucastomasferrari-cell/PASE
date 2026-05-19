// Repository de item_grupos (grupos del catálogo).
// Refactor 2026-05-19: sin herencia de clase.

import * as base from './base';
import type { LocalItemGrupo } from '../schema';

export const gruposRepo = {
  getById: (id: number) => base.getById<'item_grupos'>('item_grupos', id),
  put: (row: LocalItemGrupo, opts?: base.PutOptions) => base.put<'item_grupos'>('item_grupos', row, opts),
  putMany: (rows: LocalItemGrupo[], opts?: base.PutOptions) => base.putMany<'item_grupos'>('item_grupos', rows, opts),
  delete: (id: number) => base.deleteById('item_grupos', id),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'item_grupos'>('item_grupos', indexName, value),

  async listByTenant(tenantId: string): Promise<LocalItemGrupo[]> {
    const all = await base.findByIndex<'item_grupos'>('item_grupos', 'by_tenant', tenantId);
    return all
      .filter((g) => !g.deleted_at)
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id);
  },

  async replaceForTenant(tenantId: string, rows: LocalItemGrupo[]): Promise<void> {
    const db = await base.getDb();
    const tx = db.transaction('item_grupos', 'readwrite');
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
