import { useEffect, useState } from 'react';

// Hook para debouncear un valor reactivo (típicamente input de búsqueda o
// inputs de fecha). Útil cuando el `value` se usa como dependencia de una
// query a Supabase y querés evitar un fetch por cada tecla.
//
// Uso típico:
//   const [search, setSearch] = useState('');
//   const debouncedSearch = useDebouncedValue(search, 300);
//   useEffect(() => { load(debouncedSearch); }, [debouncedSearch]);
//
// El primer render devuelve el valor inicial inmediato (sin esperar el
// timeout) — el debounce solo aplica a cambios subsiguientes.
//
// Convención C6 del plan sunny-creek: "toda búsqueda/filtro de texto usa
// useDebouncedValue antes de pegar a DB" para evitar flood de queries.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
