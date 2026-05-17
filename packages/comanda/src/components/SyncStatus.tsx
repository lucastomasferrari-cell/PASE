import { useEffect, useState } from 'react';
import { CloudCheck, CloudOff, CloudUpload, CloudDownload, CircleAlert } from 'lucide-react';
import { useSync } from '@/lib/sync/useSync';
import { cn } from '@/lib/utils';

// Indicador visual del estado del syncEngine. Se monta en el header del POS
// junto a otros indicadores (BusyMode, FullscreenToggle, etc).
//
// Estados visuales:
//   idle (todo sync, 0 pendientes)  → check verde
//   idle con pendientes              → check ámbar + contador
//   pulling                          → spinner azul (descarga)
//   pushing                          → spinner ámbar (subida)
//   offline                          → ícono offline gris
//   error                            → triángulo rojo + tooltip con mensaje
//
// Tooltip muestra: "Última sync: hace 5s" + contador pendientes + failed.

export function SyncStatus() {
  const { state, triggerPush } = useSync();
  const [now, setNow] = useState(Date.now());

  // Tick cada 10s para refrescar el "hace X" del tooltip sin reconsultar
  // el syncEngine.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Tooltip text — humano y específico
  const tooltip = (() => {
    const lines: string[] = [];
    switch (state.kind) {
      case 'idle':
        if (state.lastSyncAt) {
          const secs = Math.floor((now - new Date(state.lastSyncAt).getTime()) / 1000);
          const human = secs < 60 ? `hace ${secs}s`
            : secs < 3600 ? `hace ${Math.floor(secs / 60)} min`
              : `hace ${Math.floor(secs / 3600)}h`;
          lines.push(`Sincronizado ${human}`);
        } else {
          lines.push('Sincronizado');
        }
        break;
      case 'pulling':
        lines.push('Descargando cambios del servidor…');
        break;
      case 'pushing':
        lines.push('Subiendo cambios locales al servidor…');
        break;
      case 'offline':
        lines.push('Sin conexión — operaciones quedan en cola');
        break;
      case 'error':
        lines.push(`Error de sincronización: ${state.message}`);
        break;
    }
    if (state.pendingOps > 0) lines.push(`${state.pendingOps} operación(es) en cola`);
    if (state.failedOps > 0) lines.push(`⚠ ${state.failedOps} operación(es) requieren atención`);
    if (state.kind === 'idle' && state.pendingOps === 0) lines.push('Click para forzar sincronización');
    return lines.join(' · ');
  })();

  const Icon = (() => {
    switch (state.kind) {
      case 'pulling':  return CloudDownload;
      case 'pushing':  return CloudUpload;
      case 'offline':  return CloudOff;
      case 'error':    return CircleAlert;
      case 'idle':
      default:         return CloudCheck;
    }
  })();

  const tone = (() => {
    if (state.failedOps > 0) return 'text-destructive';
    switch (state.kind) {
      case 'pulling':  return 'text-blue-600 animate-pulse';
      case 'pushing':  return 'text-amber-600 animate-pulse';
      case 'offline':  return 'text-muted-foreground';
      case 'error':    return 'text-destructive';
      case 'idle':
        return state.pendingOps > 0 ? 'text-amber-600' : 'text-success';
    }
  })();

  return (
    <button
      type="button"
      onClick={() => { void triggerPush(); }}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent transition-colors relative',
        tone,
      )}
    >
      <Icon className="h-4 w-4" />
      {state.pendingOps > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 text-[9px] font-bold rounded-full bg-warning text-warning-foreground inline-flex items-center justify-center tabular-nums">
          {state.pendingOps > 99 ? '99+' : state.pendingOps}
        </span>
      )}
    </button>
  );
}
