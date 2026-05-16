// Carrito de tienda online — vive solo en sessionStorage del cliente.
// Subscribe pattern para que TiendaHome y TiendaCheckout compartan
// estado sin React Context global, vía useSyncExternalStore.
//
// IMPORTANTE: el snapshot DEBE ser referencialmente estable mientras
// el estado no cambie. useSyncExternalStore llama a getSnapshot varias
// veces durante el render para detectar tearing — si devolvemos un
// objeto nuevo en cada llamada (ej: parseando sessionStorage o
// retornando `{ slug, items: [], ... }` literal), React entra en
// loop infinito ("Maximum update depth exceeded").
//
// Patrón: cacheamos el snapshot por slug. Solo se invalida cuando
// `set/clear` lo actualizan o cuando cambia el slug pedido.

export interface CarritoItem {
  item_id: number;
  nombre: string;
  emoji: string | null;
  precio: number;
  cantidad: number;
  modificadores: { nombre: string; precio_extra: number }[];
  notas: string;
}

export interface CarritoState {
  slug: string;
  items: CarritoItem[];
  tipoEntrega: 'retiro' | 'delivery';
  direccion: string;
  // Sprint 2026-05-16: coords de geocoding (GeoRef o Google). NULL hasta que
  // el cliente elija una sugerencia del autocomplete.
  direccion_lat?: number | null;
  direccion_lon?: number | null;
}

const KEY = 'comanda-tienda-carrito';

const listeners: Set<() => void> = new Set();

/** Snapshot vivo. Se hidrata desde sessionStorage en el primer get(). */
let snapshot: CarritoState | null = null;

function leerSession(): CarritoState | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CarritoState) : null;
  } catch { return null; }
}

function escribirSession(s: CarritoState | null): void {
  try {
    if (!s) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage lleno o deshabilitado, ignoramos */ }
}

function emit(): void { for (const cb of listeners) cb(); }

export const carritoStore = {
  /**
   * Devuelve la snapshot actual para el slug pedido. Referencia estable
   * entre llamadas mientras el estado interno no cambie. Si el slug
   * cambia (usuario navega a otra tienda), se reinicia el snapshot.
   */
  get(slug: string): CarritoState {
    if (snapshot && snapshot.slug === slug) return snapshot;
    const stored = leerSession();
    snapshot = stored && stored.slug === slug
      ? stored
      : { slug, items: [], tipoEntrega: 'retiro', direccion: '' };
    return snapshot;
  },
  set(s: CarritoState) {
    snapshot = s;
    escribirSession(s);
    emit();
  },
  clear() {
    snapshot = null;
    escribirSession(null);
    emit();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

export function calcularSubtotal(items: CarritoItem[]): number {
  return items.reduce((acc, it) => {
    const extras = it.modificadores.reduce((s, m) => s + (m.precio_extra ?? 0), 0);
    return acc + (it.precio + extras) * it.cantidad;
  }, 0);
}
