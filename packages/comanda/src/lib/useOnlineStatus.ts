import { useEffect, useState } from 'react';
import { db } from './supabase';

// Hook que retorna estado online/offline real (no solo navigator.onLine).
//
// navigator.onLine miente: dice TRUE si hay IP asignada, aunque la red no
// llegue a Supabase (caso típico: WiFi del local andando pero sin internet
// real, o WiFi cortado mientras el dispositivo guarda config viejo).
//
// Estrategia:
//   - Estado inicial = navigator.onLine.
//   - Ping a Supabase cada 30s para confirmar (consulta cheap a tablas vivas).
//   - Si el ping falla por timeout o network error → offline.
//   - Si vuelve a responder → online.
//   - También escuchamos los eventos del browser (online/offline) para
//     reaccionar rápido a cambios obvios (WiFi cortado/recuperado).

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;

export function useOnlineStatus() {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function ping() {
      // Si el browser dice que está offline, no gastamos request.
      if (!navigator.onLine) {
        if (!cancelled) setOnline(false);
        return;
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
        // Query super liviana: head request + count exact = solo cuenta filas
        // sin transferir data. Si Supabase responde, hay conectividad real.
        const { error } = await db
          .from('locales')
          .select('id', { head: true, count: 'exact' })
          .limit(1)
          .abortSignal(controller.signal);
        clearTimeout(timeout);
        if (!cancelled) setOnline(!error);
      } catch {
        if (!cancelled) setOnline(false);
      }
    }

    // Ping inmediato al mount + cada PING_INTERVAL_MS
    void ping();
    timer = setInterval(ping, PING_INTERVAL_MS);

    // Browser events: reaccionar rápido a cambios obvios
    function onOnline() { void ping(); }
    function onOffline() { setOnline(false); }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}
