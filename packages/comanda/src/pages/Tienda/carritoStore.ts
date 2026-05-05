// Carrito de tienda online — vive solo en sessionStorage del cliente.
// Subscribe pattern simple para que TiendaHome y TiendaCheckout compartan
// estado sin React Context global.

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
}

const KEY = 'comanda-tienda-carrito';

function read(): CarritoState | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CarritoState) : null;
  } catch { return null; }
}

function write(s: CarritoState | null): void {
  if (!s) sessionStorage.removeItem(KEY);
  else sessionStorage.setItem(KEY, JSON.stringify(s));
  for (const cb of listeners) cb();
}

const listeners: Set<() => void> = new Set();

export const carritoStore = {
  get(slug: string): CarritoState {
    const s = read();
    if (s && s.slug === slug) return s;
    return { slug, items: [], tipoEntrega: 'retiro', direccion: '' };
  },
  set(s: CarritoState) { write(s); },
  clear() { write(null); },
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
