// Alcance del editor de catálogo: qué menú estás editando.
//   'maestro' → el menú MAESTRO de la marca (items/grupos sin sucursal,
//               local_id NULL). Es la plantilla que cada local importa.
//   number    → una SUCURSAL puntual (local_id = ese id). Editás su copia
//               importada sin tocar el maestro.
// Persiste en localStorage y se comparte entre las pestañas de Catálogo
// (Items / Grupos / Precios / Combos) — mismo patrón que localActivo.ts.

import { useEffect, useState } from 'react';

export type CatalogoScope = 'maestro' | number;

const LS_KEY = 'comanda.catalogo_scope';
const SCOPE_CHANGED_EVENT = 'comanda:catalogo-scope-changed';

export function readCatalogoScope(): CatalogoScope {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw || raw === 'maestro') return 'maestro';
    const n = Number(raw);
    return Number.isFinite(n) ? n : 'maestro';
  } catch {
    return 'maestro';
  }
}

export function writeCatalogoScope(scope: CatalogoScope) {
  try {
    localStorage.setItem(LS_KEY, String(scope));
    window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT, { detail: scope }));
  } catch { /* no-op */ }
}

// Hook: alcance actual + setter, sincronizado entre componentes de la misma tab.
export function useCatalogoScope(): [CatalogoScope, (s: CatalogoScope) => void] {
  const [scope, setScope] = useState<CatalogoScope>(() => readCatalogoScope());

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<CatalogoScope>).detail;
      setScope(next);
    };
    window.addEventListener(SCOPE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SCOPE_CHANGED_EVENT, handler);
  }, []);

  const set = (s: CatalogoScope) => {
    writeCatalogoScope(s);
    setScope(s);
  };

  return [scope, set];
}

// Helpers para traducir el scope a los filtros de listItems/listGrupos.
export function scopeToItemsFilter(scope: CatalogoScope): { maestro?: boolean; localId?: number | null } {
  return scope === 'maestro' ? { maestro: true } : { localId: scope };
}
// local_id que se graba al CREAR un item/grupo en este alcance.
export function scopeLocalId(scope: CatalogoScope): number | null {
  return scope === 'maestro' ? null : scope;
}
