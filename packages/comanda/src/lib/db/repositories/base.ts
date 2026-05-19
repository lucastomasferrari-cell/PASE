// BaseRepository — helpers genéricos CRUD sobre IndexedDB.
//
// IMPORTANTE: en vez de `abstract class` (que requiere `extends`
// cross-file y rompe en builds con code splitting agresivo), exponemos
// FUNCIONES PURAS. Los repos concretos las llaman directamente sin
// herencia. El bug 2026-05-19 ("Class extends value undefined") se
// resuelve definitivamente con este patrón.
//
// Uso típico desde un repo concreto:
//
//   import { getById, put, findByIndex } from './base';
//   export const itemsRepo = {
//     getById: (id: number) => getById<LocalItem>('items', id),
//     // ... métodos específicos del dominio
//   };

import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { getDb } from '../index';
import type { StoreName, StoreTypes, LocalMeta } from '../schema';

export function nowISO(): string {
  return new Date().toISOString();
}

export type StoreKey = IDBValidKey;

export interface PutOptions {
  skipDirty?: boolean;
}

// ─── Operaciones genéricas ─────────────────────────────────────────────────

export async function getById<S extends StoreName>(
  storeName: S, id: StoreKey,
): Promise<StoreTypes[S] | undefined> {
  const db = await getDb();
  return (await db.get(storeName, id)) as StoreTypes[S] | undefined;
}

export async function getAll<S extends StoreName>(
  storeName: S,
): Promise<StoreTypes[S][]> {
  const db = await getDb();
  return (await db.getAll(storeName)) as StoreTypes[S][];
}

export async function count(storeName: StoreName): Promise<number> {
  const db = await getDb();
  return db.count(storeName);
}

export async function put<S extends StoreName>(
  storeName: S, row: StoreTypes[S], opts: PutOptions = {},
): Promise<StoreKey> {
  const db = await getDb();
  const enriched = enrichForWrite(row, opts);
  return db.put(storeName, enriched);
}

export async function putMany<S extends StoreName>(
  storeName: S, rows: StoreTypes[S][], opts: PutOptions = {},
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(storeName, 'readwrite');
  for (const r of rows) {
    const enriched = enrichForWrite(r, opts);
    void tx.store.put(enriched);
  }
  await tx.done;
}

export async function deleteById(storeName: StoreName, id: StoreKey): Promise<void> {
  const db = await getDb();
  await db.delete(storeName, id);
}

export async function clearStore(storeName: StoreName): Promise<void> {
  const db = await getDb();
  await db.clear(storeName);
}

export async function findByIndex<S extends StoreName>(
  storeName: S, indexName: string, value: IDBValidKey,
): Promise<StoreTypes[S][]> {
  const db = await getDb();
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.store.index(indexName);
  const results = (await index.getAll(value)) as StoreTypes[S][];
  await tx.done;
  return results;
}

export async function findDirty<S extends StoreName>(
  storeName: S,
): Promise<StoreTypes[S][]> {
  const db = await getDb();
  const tx = db.transaction(storeName, 'readonly');
  const all = (await tx.store.getAll()) as StoreTypes[S][];
  await tx.done;
  return all.filter((r) => (r as unknown as LocalMeta)._local_dirty === true);
}

export async function markSynced<S extends StoreName>(
  storeName: S, id: StoreKey,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(storeName, 'readwrite');
  const row = (await tx.store.get(id)) as (StoreTypes[S] & LocalMeta) | undefined;
  if (!row) { await tx.done; return; }
  row._local_dirty = false;
  row._local_synced_at = nowISO();
  void tx.store.put(row);
  await tx.done;
}

// ─── Transacción multi-store ───────────────────────────────────────────────

export async function withTx<R>(
  mode: IDBTransactionMode,
  stores: StoreName[],
  fn: (tx: IDBPTransaction<unknown, StoreName[], typeof mode>) => Promise<R>,
): Promise<R> {
  const db = await getDb();
  const tx = db.transaction(stores as unknown as string[], mode);
  try {
    const result = await fn(tx as unknown as IDBPTransaction<unknown, StoreName[], typeof mode>);
    await tx.done;
    return result;
  } catch (err) {
    tx.abort();
    throw err;
  }
}

// ─── Helper interno: enriquece la fila con metadata local ──────────────────

function enrichForWrite<S extends StoreName>(
  row: StoreTypes[S], opts: PutOptions,
): StoreTypes[S] {
  if (opts.skipDirty) {
    return { ...row, _local_dirty: false, _local_synced_at: nowISO() };
  }
  return {
    ...row,
    _local_dirty: true,
    _local_op: (row as unknown as LocalMeta)._local_op ?? 'update',
  };
}

// ─── Re-export getDb para que los repos no tengan que importarlo aparte ───
export { getDb };
export type { IDBPDatabase };
