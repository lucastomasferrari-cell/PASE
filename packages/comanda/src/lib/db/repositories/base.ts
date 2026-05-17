// BaseRepository — CRUD genérico sobre IndexedDB para un store dado.
//
// Cada repo concreto extiende esta clase y agrega queries específicas del
// dominio (ej. `findByGrupoActivo` en itemsRepo). Lo común vive acá.
//
// Decisiones de diseño:
//   - Métodos async, devuelven Promise siempre. IndexedDB es async por
//     naturaleza.
//   - `getAll()` carga toda la tabla en memoria. Para tablas grandes (>5k
//     filas) usar índices + cursors (no implementado por defecto, agregar en
//     el repo concreto cuando haga falta).
//   - Errores se propagan crudos. El consumer es responsable de catch +
//     mapeo a UX (toast, retry, etc).
//   - Mutations marcan `_local_dirty=true` para que el sync engine sepa
//     que hay que push. Override si querés saltearlo (ej. al hacer pull
//     desde el cloud, no marcar dirty).

import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { getDb } from '../index';
import type { StoreName, StoreTypes, LocalMeta } from '../schema';

// Helper: timestamp ISO actual en formato compatible Postgres/Supabase.
export function nowISO(): string {
  return new Date().toISOString();
}

// Tipo de la primary key del store. IndexedDB acepta string|number|Date|...
// pero en nuestro caso es siempre number (BIGSERIAL) o string (UUID después
// de Fase 3). Mantenemos `IDBValidKey` para no forzar antes de tiempo.
export type StoreKey = IDBValidKey;

export interface PutOptions {
  // skipDirty=true cuando estás guardando desde un pull (no es cambio local
  // que haya que sincronizar al cloud). Default false.
  skipDirty?: boolean;
}

export abstract class BaseRepository<S extends StoreName> {
  protected readonly storeName: S;

  constructor(storeName: S) {
    this.storeName = storeName;
  }

  protected async getDb(): Promise<IDBPDatabase> {
    return getDb();
  }

  // ── Operaciones básicas ──────────────────────────────────────────────────

  async getById(id: StoreKey): Promise<StoreTypes[S] | undefined> {
    const db = await this.getDb();
    return (await db.get(this.storeName, id)) as StoreTypes[S] | undefined;
  }

  async getAll(): Promise<StoreTypes[S][]> {
    const db = await this.getDb();
    return (await db.getAll(this.storeName)) as StoreTypes[S][];
  }

  async count(): Promise<number> {
    const db = await this.getDb();
    return db.count(this.storeName);
  }

  async put(row: StoreTypes[S], opts: PutOptions = {}): Promise<StoreKey> {
    const db = await this.getDb();
    const enriched = this.enrichForWrite(row, opts);
    return db.put(this.storeName, enriched);
  }

  async putMany(rows: StoreTypes[S][], opts: PutOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, 'readwrite');
    for (const r of rows) {
      const enriched = this.enrichForWrite(r, opts);
      void tx.store.put(enriched);
    }
    await tx.done;
  }

  async delete(id: StoreKey): Promise<void> {
    const db = await this.getDb();
    await db.delete(this.storeName, id);
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    await db.clear(this.storeName);
  }

  // ── Queries por índice ───────────────────────────────────────────────────

  // Devuelve todas las filas con valor exacto en el índice indicado.
  async findByIndex(indexName: string, value: IDBValidKey): Promise<StoreTypes[S][]> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, 'readonly');
    const index = tx.store.index(indexName);
    const results = (await index.getAll(value)) as StoreTypes[S][];
    await tx.done;
    return results;
  }

  // ── Sync helpers — usados por el sync engine en Fase 2 ──────────────────

  // Lista filas pendientes de push (las marcadas con _local_dirty=true).
  // Override en repos concretos si necesitás ordenamiento específico.
  async findDirty(): Promise<StoreTypes[S][]> {
    const db = await this.getDb();
    // Algunos stores no tienen índice 'by_dirty' (sync_meta, pending_ops).
    // Cuando es así, fallback a getAll + filter.
    const tx = db.transaction(this.storeName, 'readonly');
    const hasIndex = Array.from(tx.store.indexNames).includes('by_dirty');
    if (hasIndex) {
      // IndexedDB no permite key=true literal en algunos browsers — usamos
      // getAll + filter por safety.
      const all = (await tx.store.getAll()) as StoreTypes[S][];
      await tx.done;
      return all.filter((r) => (r as unknown as LocalMeta)._local_dirty === true);
    } else {
      const all = (await tx.store.getAll()) as StoreTypes[S][];
      await tx.done;
      return all.filter((r) => (r as unknown as LocalMeta)._local_dirty === true);
    }
  }

  // Marca una fila como sincronizada (clean). Se llama después del push OK.
  async markSynced(id: StoreKey): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, 'readwrite');
    const row = (await tx.store.get(id)) as (StoreTypes[S] & LocalMeta) | undefined;
    if (!row) { await tx.done; return; }
    row._local_dirty = false;
    row._local_synced_at = nowISO();
    void tx.store.put(row);
    await tx.done;
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  protected enrichForWrite(row: StoreTypes[S], opts: PutOptions): StoreTypes[S] {
    if (opts.skipDirty) {
      // Pull desde cloud: clean, fresh sync timestamp.
      return {
        ...row,
        _local_dirty: false,
        _local_synced_at: nowISO(),
      };
    }
    // Mutation local: dirty, pendiente de push.
    return {
      ...row,
      _local_dirty: true,
      _local_op: (row as unknown as LocalMeta)._local_op ?? 'update',
    };
  }

  // Transaction helper para operaciones multi-store atómicas (ej. agregar
  // item Y actualizar total de venta en una sola TX).
  protected async tx<R>(
    mode: IDBTransactionMode,
    stores: StoreName[],
    fn: (tx: IDBPTransaction<unknown, StoreName[], typeof mode>) => Promise<R>,
  ): Promise<R> {
    const db = await this.getDb();
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
}
