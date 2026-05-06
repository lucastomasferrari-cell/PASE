// Carrito menú QR — análogo al de tienda pero por token (cliente en mesa).
//
// Mismo cuidado que carritoStore.ts: el snapshot por token DEBE ser
// referencialmente estable. useSyncExternalStore llama a getSnapshot
// varias veces durante el render — si devolvemos un array `[]` nuevo
// cada vez, React entra en loop infinito.

export interface MenuQrCartItem {
  item_id: number;
  nombre: string;
  emoji: string | null;
  precio: number;
  cantidad: number;
  notas: string;
}

const KEY_PREFIX = 'comanda-menuqr-';
const EMPTY: ReadonlyArray<MenuQrCartItem> = Object.freeze([]);

const listeners = new Map<string, Set<() => void>>();
/** Snapshot por token. Se invalida solo en set/clear o lectura inicial. */
const snapshots = new Map<string, MenuQrCartItem[]>();

function emit(token: string): void {
  const set = listeners.get(token);
  if (set) for (const cb of set) cb();
}

function leerSession(token: string): MenuQrCartItem[] | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + token);
    return raw ? (JSON.parse(raw) as MenuQrCartItem[]) : null;
  } catch { return null; }
}

function escribirSession(token: string, items: MenuQrCartItem[]): void {
  try {
    if (items.length === 0) sessionStorage.removeItem(KEY_PREFIX + token);
    else sessionStorage.setItem(KEY_PREFIX + token, JSON.stringify(items));
  } catch { /* storage lleno o deshabilitado */ }
}

export const menuQrCart = {
  /**
   * Devuelve la snapshot actual del carrito para `token`. Referencia
   * estable: si el carrito está vacío, siempre el mismo array vacío
   * congelado. Si tiene items, el array cacheado se reusa hasta que
   * un set() lo reemplace.
   */
  get(token: string): MenuQrCartItem[] {
    const cached = snapshots.get(token);
    if (cached) return cached;
    const stored = leerSession(token);
    if (stored && stored.length > 0) {
      snapshots.set(token, stored);
      return stored;
    }
    // Vacío: cachear EMPTY como referencia estable global.
    snapshots.set(token, EMPTY as MenuQrCartItem[]);
    return EMPTY as MenuQrCartItem[];
  },
  set(token: string, items: MenuQrCartItem[]) {
    snapshots.set(token, items);
    escribirSession(token, items);
    emit(token);
  },
  clear(token: string) {
    snapshots.delete(token);
    escribirSession(token, []);
    emit(token);
  },
  subscribe(token: string, cb: () => void) {
    let s = listeners.get(token);
    if (!s) { s = new Set(); listeners.set(token, s); }
    s.add(cb);
    return () => { s!.delete(cb); };
  },
};
