// Persiste el último modo POS activo (salon / mostrador / pedidos) para que
// el sidebar sepa qué icono marcar cuando el usuario está dentro de una venta
// (/pos/venta/:id) o del detalle de un pedido (/pos/pedidos/:id) — rutas que
// no tienen el slug del modo en el path.
//
// Se actualiza:
//   - Al entrar a /pos/{salon,mostrador,pedidos} (screens de listado).
//   - Al cargar una venta en VentaScreen (usa venta.modo).
//   - Al cargar un pedido en PedidoDetalle (siempre 'pedidos').
//
// Sidebar lee este valor + pathname para decidir qué highlightear.

import { useEffect, useState } from 'react';
import type { ModoVenta } from '@/types/database';

const SS_KEY = 'comanda.lastPosModo';

// Custom event para que otros tabs/componentes reaccionen sin polling.
const EVT = 'comanda:pos-modo-changed';

export function setLastPosModo(modo: ModoVenta) {
  try {
    sessionStorage.setItem(SS_KEY, modo);
    window.dispatchEvent(new CustomEvent(EVT, { detail: modo }));
  } catch { /* no-op */ }
}

export function getLastPosModo(): ModoVenta | null {
  try {
    const v = sessionStorage.getItem(SS_KEY);
    if (v === 'salon' || v === 'mostrador' || v === 'pedidos') return v;
    return null;
  } catch {
    return null;
  }
}

// Hook reactivo — devuelve el modo actual y se re-renderiza cuando cambia.
export function useLastPosModo(): ModoVenta | null {
  const [modo, setModo] = useState<ModoVenta | null>(() => getLastPosModo());
  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent<ModoVenta>).detail;
      setModo(detail);
    }
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, []);
  return modo;
}
