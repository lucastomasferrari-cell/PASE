import { useEffect, useRef } from 'react';

/**
 * Ejecuta `fn` cada `intervalMs` mientras la pestaña está visible.
 * Pausa automáticamente cuando la pestaña se oculta y se re-ejecuta al
 * volver visible si pasaron más de `intervalMs` desde la última ejecución.
 *
 * Reemplaza el patrón viejo de `useEffect(() => { setInterval(fn, ms); ... })`
 * que sigue corriendo con la pestaña oculta y desperdicia queries.
 *
 * NO ejecuta `fn` inmediatamente al montar (igual que setInterval). Si
 * necesitás un fetch inicial, llamalo manualmente antes:
 *   useEffect(() => { fetchData(); }, []);
 *   useVisiblePolling(fetchData, 10000);
 */
export function useVisiblePolling(fn: () => void | Promise<void>, intervalMs: number): void {
  const fnRef = useRef(fn);
  const lastRunRef = useRef<number>(Date.now());

  // Mantenemos la fn más reciente en una ref para que no haya que pasar
  // useCallback en el caller.
  useEffect(() => { fnRef.current = fn; }, [fn]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (intervalId) return;
      intervalId = setInterval(() => {
        fnRef.current();
        lastRunRef.current = Date.now();
      }, intervalMs);
    }

    function stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        // Si pasó más del interval mientras la pestaña estaba oculta,
        // ejecutar inmediatamente al volver para refrescar el estado.
        if (Date.now() - lastRunRef.current > intervalMs) {
          fnRef.current();
          lastRunRef.current = Date.now();
        }
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [intervalMs]);
}
