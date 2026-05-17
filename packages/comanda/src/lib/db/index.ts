// DB local singleton. Una instancia por sesión del browser.
//
// El consumer típico es vía repositorios (lib/db/repositories/*). El
// `getDb()` raw se usa solo desde dentro de la lib/db, no desde components
// ni services de pages.
//
// Reset: borrar todo el DB y reabrir. Util en logout o cuando schema
// cambió incompatible. En producción rara vez se usa.

import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from './schema';
import { runMigrations } from './migrations';

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        runMigrations({ db, oldVersion, newVersion, transaction });
      },
      blocked() {
        console.warn('[db] open blocked — otra pestaña tiene una versión vieja abierta');
      },
      blocking() {
        // El usuario abrió otra pestaña con versión nueva. Cerramos esta
        // conexión para no bloquearla.
        dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// Reset: borra TODA la DB local. Llamar en logout para que un user nuevo
// no vea datos del anterior.
export async function resetDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      console.warn('[db] reset blocked — esperar a cerrar otras pestañas');
      resolve(); // resolvemos igual; otras pestañas se cierran solas
    };
  });
}

// Para tests: reset el singleton sin tocar IndexedDB (que en test puede
// usar fake-indexeddb que se resetea con cada `vi.resetModules()`).
export function _resetSingletonForTest(): void {
  dbPromise = null;
}

export { DB_NAME, DB_VERSION } from './schema';
