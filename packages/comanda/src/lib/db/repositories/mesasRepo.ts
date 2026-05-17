// Repository de mesas + helpers para enriquecer con la venta abierta.

import { BaseRepository } from './base';
import { getDb } from '../index';
import type { LocalMesa, LocalVentaPos } from '../schema';
import { ventasRepo } from './ventasRepo';

class MesasRepository extends BaseRepository<'mesas'> {
  constructor() {
    super('mesas');
  }

  async listByLocal(localId: number): Promise<LocalMesa[]> {
    const all = await this.findByIndex('by_local', localId);
    return all
      .filter((m) => !m.deleted_at)
      .sort((a, b) => {
        // Orden: zona asc nullsLast, después id asc
        if (a.zona && !b.zona) return -1;
        if (!a.zona && b.zona) return 1;
        if (a.zona && b.zona && a.zona !== b.zona) return a.zona.localeCompare(b.zona);
        return a.id - b.id;
      });
  }

  // Mesa con info de la venta abierta (si existe). Útil para la grid del
  // salón sin tener que joinear server-side.
  async listConVentas(localId: number): Promise<Array<LocalMesa & {
    venta_abierta_id: number | null;
    venta_total: number;
    venta_abierta_at: string | null;
  }>> {
    const [mesas, ventasAbiertas] = await Promise.all([
      this.listByLocal(localId),
      ventasRepo.listAbiertasByLocal(localId),
    ]);
    const ventaByMesa = new Map<number, LocalVentaPos>();
    for (const v of ventasAbiertas) {
      if (v.mesa_id != null) ventaByMesa.set(v.mesa_id, v);
    }
    return mesas.map((m) => {
      const v = ventaByMesa.get(m.id);
      return {
        ...m,
        venta_abierta_id: v?.id ?? null,
        venta_total: v ? Number(v.total ?? 0) : 0,
        venta_abierta_at: v?.abierta_at ?? null,
      };
    });
  }

  async replaceForLocal(localId: number, rows: LocalMesa[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('mesas', 'readwrite');
    const index = tx.store.index('by_local');
    let cursor = await index.openCursor(IDBKeyRange.only(localId));
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

export const mesasRepo = new MesasRepository();
