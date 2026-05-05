// Carrito menú QR — análogo al de tienda pero por token (cliente en mesa).

export interface MenuQrCartItem {
  item_id: number;
  nombre: string;
  emoji: string | null;
  precio: number;
  cantidad: number;
  notas: string;
}

const KEY_PREFIX = 'comanda-menuqr-';

const listeners = new Map<string, Set<() => void>>();

function emit(token: string) {
  const set = listeners.get(token);
  if (set) for (const cb of set) cb();
}

export const menuQrCart = {
  get(token: string): MenuQrCartItem[] {
    try {
      const raw = sessionStorage.getItem(KEY_PREFIX + token);
      return raw ? (JSON.parse(raw) as MenuQrCartItem[]) : [];
    } catch { return []; }
  },
  set(token: string, items: MenuQrCartItem[]) {
    if (items.length === 0) sessionStorage.removeItem(KEY_PREFIX + token);
    else sessionStorage.setItem(KEY_PREFIX + token, JSON.stringify(items));
    emit(token);
  },
  clear(token: string) { sessionStorage.removeItem(KEY_PREFIX + token); emit(token); },
  subscribe(token: string, cb: () => void) {
    let s = listeners.get(token);
    if (!s) { s = new Set(); listeners.set(token, s); }
    s.add(cb);
    return () => { s!.delete(cb); };
  },
};
