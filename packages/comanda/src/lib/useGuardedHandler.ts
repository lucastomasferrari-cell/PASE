import { useRef, useState } from "react";

// Hook anti-doble-click. Bloquea re-entrancia mientras el handler async
// está en vuelo. Espejo del hook de packages/pase/src/lib/useGuardedHandler.ts
// (no se comparte aún porque @pase/shared está vacío).
//
// Motivado por bug 2026-05-18: doble-click en "Guardar" insertaba
// registros duplicados. Aplicar a TODO handler que cree/edite/registre
// data o plata.
//
// Uso típico:
//   const guardar = useGuardedHandler(async () => { ... await db ... });
//   <button onClick={guardar.run} disabled={guardar.isPending}>
//     {guardar.isPending ? "Guardando…" : "Guardar"}
//   </button>
export function useGuardedHandler<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
): { run: (...args: TArgs) => Promise<TReturn | undefined>; isPending: boolean } {
  const [isPending, setIsPending] = useState(false);
  const inFlight = useRef(false);

  const run = async (...args: TArgs): Promise<TReturn | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setIsPending(true);
    try {
      return await fn(...args);
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  };

  return { run, isPending };
}
