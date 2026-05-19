// Hook React para pedir geolocalización del browser. Wrapper sobre
// navigator.geolocation con estados explícitos y persistencia opcional en
// sessionStorage para no re-pedir permiso cada navegación.
//
// Estados:
//   'idle'     → no se pidió todavía
//   'loading'  → esperando respuesta del browser
//   'granted'  → tenemos coords (devueltas en data)
//   'denied'   → user dijo no o el browser no soporta geolocation
//   'error'    → falló (timeout, sin GPS, etc)
//
// Privacidad: las coords NO se mandan al server desde acá. El caller decide
// qué hacer (típicamente: calcular distancia client-side).

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'comanda.user_location';
const CACHE_MS = 30 * 60 * 1000; // 30 min — coords del cliente se cachean

export interface UserLocation {
  lat: number;
  lon: number;
  timestamp: number; // epoch ms
}

export type GeolocationStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'error';

export interface UseGeolocationResult {
  status: GeolocationStatus;
  data: UserLocation | null;
  error: string | null;
  request: () => void;
  clear: () => void;
}

function readCached(): UserLocation | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserLocation;
    if (Date.now() - parsed.timestamp > CACHE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCached(loc: UserLocation): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(loc)); } catch { /* ignore */ }
}

export function useGeolocation(autoRequestIfCached = true): UseGeolocationResult {
  const cached = autoRequestIfCached ? readCached() : null;
  const [status, setStatus] = useState<GeolocationStatus>(cached ? 'granted' : 'idle');
  const [data, setData] = useState<UserLocation | null>(cached);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('denied');
      setError('El navegador no soporta geolocalización.');
      return;
    }
    setStatus('loading');
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: UserLocation = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          timestamp: Date.now(),
        };
        writeCached(loc);
        setData(loc);
        setStatus('granted');
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied');
          setError('Permiso denegado.');
        } else {
          setStatus('error');
          setError(err.message);
        }
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  const clear = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setData(null);
    setStatus('idle');
    setError(null);
  }, []);

  // Refrescar el estado si el cache expira mientras el hook está montado
  useEffect(() => {
    if (!cached) return;
    const remaining = CACHE_MS - (Date.now() - cached.timestamp);
    if (remaining <= 0) return clear();
    const id = setTimeout(() => clear(), remaining);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, data, error, request, clear };
}
