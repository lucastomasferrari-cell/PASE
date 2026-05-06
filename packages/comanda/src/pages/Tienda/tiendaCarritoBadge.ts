import { useSyncExternalStore } from 'react';

// Mini-store independiente del carrito por slug. Solo expone:
//  - el count agregado para mostrar en el badge del header.
//  - un trigger "open cart" que dispara un evento global que TiendaHome
//    escucha para abrir el sheet del carrito.
//
// Por qué separado: TiendaLayout no debería conocer el slug ni el shape
// de CarritoState. TiendaHome es el único que mantiene el estado real
// (porque depende del slug) y publica el count + abre el sheet.

const COUNT_EVT = 'tienda:carrito-count';
const OPEN_EVT = 'tienda:carrito-open';

const listeners = new Set<() => void>();
let currentCount = 0;

function emit() {
  for (const cb of listeners) cb();
}

export const tiendaCarritoBadge = {
  setCount(n: number) {
    if (n === currentCount) return;
    currentCount = n;
    emit();
    window.dispatchEvent(new CustomEvent(COUNT_EVT, { detail: n }));
  },
  openCart() {
    window.dispatchEvent(new Event(OPEN_EVT));
  },
  onOpenRequest(cb: () => void): () => void {
    window.addEventListener(OPEN_EVT, cb);
    return () => window.removeEventListener(OPEN_EVT, cb);
  },
  useCount(): number {
    return useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      () => currentCount,
      () => 0,
    );
  },
};
