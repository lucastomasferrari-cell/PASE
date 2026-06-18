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

// Cache por nombre: React StrictMode (dev) monta→desmonta→monta, llamando esto
// 2 veces con el mismo nombre → createRxDatabase choca/cuelga por DB duplicada.
// El singleton por nombre devuelve la misma instancia en el 2º montaje.
const _cache = new Map<string, Promise<SpikeDB>>();

// storage opcional: en el browser usa Dexie (IndexedDB); en tests se pasa
// getRxStorageMemory() porque Node no tiene IndexedDB.
export function crearSpikeDB(name = 'comanda-spike', storage?: RxStorage<unknown, unknown>): Promise<SpikeDB> {
  const cached = _cache.get(name);
  if (cached) return cached;
  const p = (async () => {
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
  })();
  _cache.set(name, p);
  return p;
}
