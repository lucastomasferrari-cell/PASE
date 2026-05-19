import { useRef, useState } from "react";

// Hook anti-doble-click para handlers async. Bloquea re-entrancia mientras
// el handler está en vuelo, así dos clicks rápidos solo ejecutan el primero.
//
// Motivado por bug 2026-05-18: en /equipo el botón "Guardar" insertó el
// mismo empleado 2 veces porque Anto tocó el botón dos veces rápido antes
// de que volviera la respuesta. Aplica a TODOS los handlers que crean,
// editan, registran, pagan, anulan o emiten plata/data.
//
// Uso típico (handler propio del componente):
//   const guardar = useGuardedHandler(async () => {
//     await db.from("rrhh_empleados").insert([payload]);
//     setEmpModal(null);
//   });
//   // ...
//   <button onClick={guardar.run} disabled={guardar.isPending || !valid}>
//     {guardar.isPending ? "Guardando…" : "Guardar"}
//   </button>
//
// `isPending` se usa para feedback visual y para deshabilitar el botón en
// paralelo con la guarda por ref (defense-in-depth: la ref ataja el doble
// click ANTES del re-render, el disabled tapa el caso del que mantenga
// presionado).
//
// El ref es el guard duro (sincrónico, sobrevive al re-render). El state
// es solo para UI. No usar useCallback acá: la wrapped fn no se pasa a
// children como prop estable; recrearla por render es OK.
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
