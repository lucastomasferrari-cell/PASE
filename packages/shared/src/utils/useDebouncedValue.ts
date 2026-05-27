// =============================================================================
// @pase/shared — useDebouncedValue
// =============================================================================
// AUDIT F7A#1: extract para terminar la duplicación entre PASE/COMANDA/admin.
// =============================================================================

import { useEffect, useState } from "react";

/**
 * Debounce de un valor reactivo. Devuelve el valor estable después de `delayMs`
 * sin cambios. Útil para filtros de texto antes de pegarle a la DB (regla C6).
 */
export function useDebouncedValue<T>(value: T, delayMs: number = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
