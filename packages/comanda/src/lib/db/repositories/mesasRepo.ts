// Repository de mesas + helpers para enriquecer con la venta abierta.
// Refactor 2026-05-19: sin herencia de clase.

import * as base from './base';
import type { LocalMesa, LocalVentaPos } from '../schema';
import { ventasRepo } from './ventasRepo';

export const mesasRepo = {
  getById: (id: number) => base.getById<'mesas'>('mesas', id),
  put: (row: LocalMesa, opts?: base.PutOptions) => base.put<'mesas'>('mesas', row, opts),
  putMany: (rows: LocalMesa[], opts?: base.PutOptions) => base.putMany<'mesas'>('mesas', rows, opts),
  delete: (id: number) => base.deleteById('mesas', id),
  findByIndex: (indexName: string, value: IDBValidKey) =>
    base.findByIndex<'mesas'>('mesas', indexName, value),

  async listByLocal(localId: number): Promise<LocalMesa[]> {
    const all = await base.findByIndex<'mesas'>('mesas', 'by_local', localId);
    return all
      .filter((m) => !m.deleted_at)
      .sort((a, b) => {
        if (a.zona && !b.zona) return -1;
        if (!a.zona && b.zona) return 1;
        if (a.zona && b.zona && a.zona !== b.zona) return a.zona.localeCompare(b.zona);
        return a.id - b.id;
      });
  },

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
  },

  async replaceForLocal(localId: number, rows: LocalMesa[]): Promise<void> {
    const db = await base.getDb();
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
  },
};
