// SPIKE — RxDatabase local (IndexedDB via Dexie). Descartable.
import { createRxDatabase, type RxDatabase, type RxCollection, type RxStorage } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { ventaSchema, itemSchema, pagoSchema, type VentaDoc, type ItemDoc, type PagoDoc } from './schema';

// SPIKE: sin dev-mode plugin (en RxDB v17 exige storage con validador ajv;
// no aporta al spike). RxDB funciona sin él.

export type SpikeCollections = {
  ventas: RxCollection<VentaDoc>;
  items: RxCollection<ItemDoc>;
  pagos: RxCollection<PagoDoc>;
};
export type SpikeDB = RxDatabase<SpikeCollections>;

// storage opcional: en el browser usa Dexie (IndexedDB); en tests se pasa
// getRxStorageMemory() porque Node no tiene IndexedDB.
export async function crearSpikeDB(name = 'comanda-spike', storage?: RxStorage<unknown, unknown>): Promise<SpikeDB> {
  const db = await createRxDatabase<SpikeCollections>({
    name,
    storage: storage ?? getRxStorageDexie(),
  });
  await db.addCollections({
    ventas: { schema: ventaSchema },
    items: { schema: itemSchema },
    pagos: { schema: pagoSchema },
  });
  return db;
}
