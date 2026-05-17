import { useEffect, useState } from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import { cn } from '@/lib/utils';

// Banner sticky en el top del POS que aparece cuando no hay conexión a
// Supabase. Sirve para:
//   1. Avisar al cajero/mozo que NO confíe del estado mostrado (mesas,
//      cuentas pueden estar stale).
//   2. Explicar qué SÍ puede hacer (ver catálogo, ver últimas mesas) y
//      qué NO (cobrar, mandar cocina, agregar items).
//
// Cuando vuelve online muestra brevemente un toast verde "Conectado" antes
// de desaparecer, para que el usuario sepa que ya puede operar.

export function OfflineBanner() {
  const online = useOnlineStatus();
  const [showReconnected, setShowReconnected] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (!online) {
      setWasOffline(true);
      setShowReconnected(false);
    } else if (wasOffline) {
      setShowReconnected(true);
      const t = setTimeout(() => {
        setShowReconnected(false);
        setWasOffline(false);
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [online, wasOffline]);

  if (online && !showReconnected) return null;

  return (
    <div
      className={cn(
        'sticky top-0 z-50 px-4 py-2 text-sm font-medium flex items-center justify-center gap-2 transition-colors',
        online
          ? 'bg-success text-success-foreground'
          : 'bg-destructive text-destructive-foreground',
      )}
      role="status"
      aria-live="polite"
    >
      {online ? (
        <>
          <Wifi className="h-4 w-4" />
          <span>Conectado de nuevo. Podés operar normal.</span>
        </>
      ) : (
        <>
          <WifiOff className="h-4 w-4 animate-pulse" />
          <span className="flex flex-col sm:flex-row items-center gap-x-2">
            <strong>Sin conexión.</strong>
            <span className="text-xs opacity-90">
              Catálogo en cache. No podés cobrar ni mandar a cocina hasta que vuelva.
            </span>
          </span>
        </>
      )}
    </div>
  );
}
