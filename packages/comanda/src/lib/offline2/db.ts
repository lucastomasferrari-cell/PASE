// offline2 — store local de producción (RxDB/Dexie). Reemplaza lib/sync/* (Fase 2).
// Patrón validado en el spike: singleton por nombre (evita el cuelgue de
// StrictMode al crear la DB 2 veces con el mismo nombre).
import { createRxDatabase, type RxDatabase, type RxCollection, type RxStorage } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { ventaSchema, itemSchema, pagoSchema, opSchema, type VentaDoc, type ItemDoc, type PagoDoc, type OpDoc } from './schema';

export type OfflineCollections = {
  ventas: RxCollection<VentaDoc>;
  items: RxCollection<ItemDoc>;
  pagos: RxCollection<PagoDoc>;
  ops: RxCollection<OpDoc>;
};
export type OfflineDB = RxDatabase<OfflineCollections>;

const _cache = new Map<string, Promise<OfflineDB>>();

export function crearOfflineDB(name = 'comanda-offline2', storage?: RxStorage<unknown, unknown>): Promise<OfflineDB> {
  const cached = _cache.get(name);
  if (cached) return cached;
  const p = (async () => {
    const db = await createRxDatabase<OfflineCollections>({ name, storage: storage ?? getRxStorageDexie() });
    await db.addCollections({
      ventas: { schema: ventaSchema },
      items: { schema: itemSchema },
      pagos: { schema: pagoSchema },
      ops: { schema: opSchema },
    });
    return db;
  })();
  _cache.set(name, p);
  return p;
}
