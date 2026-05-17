// Repository de items (catálogo del POS) en DB local.
//
// Lectura crítica: el cajero/mozo escanea catálogo mientras opera. La query
// más común es "items visibles_pos del tenant agrupados por grupo_id". Por
// eso el índice by_grupo + filtros en memoria son suficientes para
// catálogos típicos (200-2000 items por tenant).

import { BaseRepository } from './base';
import { getDb } from '../index';
import type { LocalItem } from '../schema';

class ItemsRepository extends BaseRepository<'items'> {
  constructor() {
    super('items');
  }

  // Listar items del tenant ordenados por orden + id. Filtros opcionales
  // por grupo y por estado. La UI hace filtrado adicional in-memory por
  // search text para evitar cursors.
  async listByTenant(
    tenantId: string,
    opts: { grupoId?: number; soloVisiblesPos?: boolean; soloDisponibles?: boolean } = {},
  ): Promise<LocalItem[]> {
    const all = await this.findByIndex('by_tenant', tenantId);
    let filtered = all;
    if (opts.grupoId != null) {
      filtered = filtered.filter((i) => i.grupo_id === opts.grupoId);
    }
    if (opts.soloVisiblesPos) {
      filtered = filtered.filter((i) => i.visible_pos);
    }
    if (opts.soloDisponibles) {
      filtered = filtered.filter((i) => i.estado === 'disponible');
    }
    // Sin deleted_at — los borrados se eliminan del local al sync.
    filtered = filtered.filter((i) => !i.deleted_at);
    return filtered.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id);
  }

  // Reemplaza el catálogo entero del tenant. Usado por `pullInitial` cuando
  // el cliente arranca el turno: snapshot atómico del catálogo.
  //
  // Implementación: borra todas las filas del tenant y reinserta. Es
  // simple y atómico dentro de una transaction. Si el catálogo crece a
  // miles de items vale la pena cambiar a "diff + apply" pero hoy no es
  // problema (200-2000 items).
  async replaceForTenant(tenantId: string, rows: LocalItem[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('items', 'readwrite');
    const index = tx.store.index('by_tenant');
    // Borrar existentes del tenant
    let cursor = await index.openCursor(IDBKeyRange.only(tenantId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    // Insertar nuevos (skipDirty=true → vienen del cloud).
    for (const r of rows) {
      await tx.store.put({ ...r, _local_dirty: false, _local_synced_at: new Date().toISOString() });
    }
    await tx.done;
  }
}

export const itemsRepo = new ItemsRepository();
