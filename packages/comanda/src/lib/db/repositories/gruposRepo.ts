// Repository de item_grupos (grupos del catálogo).

import { BaseRepository } from './base';
import { getDb } from '../index';
import type { LocalItemGrupo } from '../schema';

class GruposRepository extends BaseRepository<'item_grupos'> {
  constructor() {
    super('item_grupos');
  }

  async listByTenant(tenantId: string): Promise<LocalItemGrupo[]> {
    const all = await this.findByIndex('by_tenant', tenantId);
    return all
      .filter((g) => !g.deleted_at)
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id);
  }

  async replaceForTenant(tenantId: string, rows: LocalItemGrupo[]): Promise<void> {
    const db = await getDb();
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
  }
}

export const gruposRepo = new GruposRepository();
