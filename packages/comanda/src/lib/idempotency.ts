import { useMemo, useRef } from 'react';

// Helpers de idempotency_key para operaciones financieras (sprint 7).
//
// Los RPCs de comanda y PASE aceptan un p_idempotency_key TEXT que evita
// que un doble-click o retry duplique el efecto. El frontend genera el
// key y lo reusa hasta que la operación es exitosa o el dialog se cierra.

/**
 * Genera un idempotency_key estable durante el ciclo de vida del componente.
 * El key se mantiene mientras `seed` no cambie. Útil para dialogs:
 *   useIdempotencyKey(open ? 'open' : 'closed')
 * Cada vez que el dialog se abre, regenera el key. Mientras está abierto,
 * todos los reintentos usan el mismo key.
 *
 * Patrón de uso típico:
 *   const idempotencyKey = useIdempotencyKey(open ? `${open}` : 'closed');
 *   await service.algo({ ...data, idempotencyKey });
 */
export function useIdempotencyKey(seed: string | number = 'default'): string {
  const ref = useRef<{ seed: string | number; key: string } | null>(null);

  return useMemo(() => {
    if (!ref.current || ref.current.seed !== seed) {
      ref.current = { seed, key: crypto.randomUUID() };
    }
    return ref.current.key;
  }, [seed]);
}

/**
 * Genera un idempotency_key nuevo. Para casos one-shot fuera de un componente
 * (ej. helper de service que se llama imperativamente).
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}
