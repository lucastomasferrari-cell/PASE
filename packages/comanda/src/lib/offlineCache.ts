import { openDB, type IDBPDatabase } from 'idb';

// Cache offline para master data: items, grupos, mesas, empleados, canales.
//
// Estrategia "stale-while-revalidate":
//   - Online normal: el service responde desde Supabase y popula el cache.
//   - Offline: el service detecta error de red y devuelve lo último cacheado.
//   - Reconexión: el service vuelve a Supabase y refresca el cache.
//
// IndexedDB elegida por:
//   - Persiste entre sesiones (sessionStorage no, localStorage tiene 5MB cap).
//   - Async, no bloquea main thread (catálogos grandes pueden ser ~500KB).
//   - Estructura por tablas (object stores) mappea natural al modelo.
//
// Stale-time: 24hs. Si la última sync fue > 24hs, no devolvemos cache
// (preferimos error a mostrar precios viejos por días).

const DB_NAME = 'comanda-offline';
const DB_VERSION = 1;
const STALE_MS = 24 * 60 * 60 * 1000;

export type CacheKey =
  | 'items'
  | 'grupos'
  | 'mesas'
  | 'empleados'
  | 'canales'
  | 'modificadores'
  | 'lista_precios';

interface CacheEntry<T> {
  key: string;          // 'items:tenant_id' por ejemplo, para scope por tenant
  data: T;
  cached_at: number;    // timestamp ms
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Un object store por cada master data table. Indexado por key.
        const stores: CacheKey[] = [
          'items', 'grupos', 'mesas', 'empleados', 'canales',
          'modificadores', 'lista_precios',
        ];
        for (const store of stores) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'key' });
          }
        }
      },
    });
  }
  return dbPromise;
}

// Guarda un snapshot del data en cache para esa key.
export async function cacheSet<T>(store: CacheKey, key: string, data: T): Promise<void> {
  try {
    const db = await getDb();
    const entry: CacheEntry<T> = { key, data, cached_at: Date.now() };
    await db.put(store, entry);
  } catch (err) {
    // No bloquear si IndexedDB falla (modo incógnito, cuota llena, etc).
    console.warn('[offlineCache] cacheSet fail', store, err);
  }
}

// Lee del cache. Devuelve null si:
//   - no hay entrada
//   - la entrada está stale (> STALE_MS)
//   - IndexedDB falla
export async function cacheGet<T>(store: CacheKey, key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const entry = (await db.get(store, key)) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cached_at > STALE_MS) return null;
    return entry.data;
  } catch (err) {
    console.warn('[offlineCache] cacheGet fail', store, err);
    return null;
  }
}

// Devuelve metadata del cache (cuándo se cacheó). Útil para mostrar
// "última sincronización hace X min" en el banner offline.
export async function cacheAge(store: CacheKey, key: string): Promise<number | null> {
  try {
    const db = await getDb();
    const entry = (await db.get(store, key)) as CacheEntry<unknown> | undefined;
    if (!entry) return null;
    return Date.now() - entry.cached_at;
  } catch {
    return null;
  }
}

// Limpia cache de un store específico. Útil al logout.
export async function cacheClear(store: CacheKey): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(store);
  } catch (err) {
    console.warn('[offlineCache] cacheClear fail', store, err);
  }
}

// Detecta si un error de Supabase es "network error" (= offline o timeout).
// Otros errores (RLS, validación, etc.) NO son offline.
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { message?: string; code?: string; name?: string };
  const msg = (e.message ?? '').toLowerCase();
  return (
    e.name === 'AbortError' ||
    e.code === 'NETWORK_ERROR' ||
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('timeout')
  );
}
