// SyncStatusBadge — chip mini en la barra superior del POS que muestra el
// estado de sincronización offline-first.
//
// Solo aparece cuando el feature flag offlineFirstVentas está activo. Si el
// flag está off, devuelve null (no ensucia la UI normal).
//
// Estados:
//   idle (0 pending)     → "Sincronizado" verde (o nada si querés discreción)
//   idle (>0 pending)    → "X pendientes" amarillo (algo se quedó sin pushear)
//   pulling/pushing      → "Sincronizando…" azul, ícono giratorio
//   offline              → "Sin conexión" rojo + N pendientes
//   error                → "Error sync" rojo + tooltip con mensaje
//
// Mantenelo lo más pequeño y sobrio posible — el cajero no necesita pensar
// en esto, solo necesita un check visual de 1 segundo.

import { CheckCircle2, CloudOff, Loader2, AlertCircle, Clock } from 'lucide-react';
import { useSyncState } from '@/lib/sync/useSyncState';
import { featureFlags } from '@/lib/featureFlags';
import { cn } from '@/lib/utils';

export function SyncStatusBadge() {
  const state = useSyncState();
  if (!featureFlags.offlineFirstVentas) return null;

  const pending = state.pendingOps;
  const failed = state.failedOps;

  let icon, label, color, title;
  if (state.kind === 'offline') {
    icon = <CloudOff className="h-3.5 w-3.5" />;
    label = pending > 0 ? `Offline · ${pending} pendiente${pending === 1 ? '' : 's'}` : 'Offline';
    color = 'text-destructive bg-destructive/10 border-destructive/30';
    title = 'Sin conexión. Las operaciones se guardan local y sincronizan cuando vuelva internet.';
  } else if (state.kind === 'pulling' || state.kind === 'pushing') {
    icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    label = state.kind === 'pulling' ? 'Sincronizando catálogo…' : `Subiendo ${pending} cambio${pending === 1 ? '' : 's'}…`;
    color = 'text-blue-600 bg-blue-500/10 border-blue-500/30 dark:text-blue-400';
    title = 'Sincronizando con el servidor';
  } else if (state.kind === 'error') {
    icon = <AlertCircle className="h-3.5 w-3.5" />;
    label = 'Error sync';
    color = 'text-destructive bg-destructive/10 border-destructive/30';
    title = `Error sincronizando: ${state.message}`;
  } else if (pending > 0) {
    // Pendientes legítimas: esperando el próximo push (van a sincronizar solas).
    icon = <Clock className="h-3.5 w-3.5" />;
    label = `${pending} pendiente${pending === 1 ? '' : 's'}`;
    color = 'text-amber-700 bg-amber-500/10 border-amber-500/30 dark:text-amber-400';
    title = failed > 0
      ? `${pending} esperando sincronizar · ${failed} con error (se descartan solas)`
      : `${pending} operaciones esperando sincronizar`;
  } else if (failed > 0) {
    // Solo ops `failed`, sin pendientes: NO son "pendientes" — son operaciones
    // que no se pudieron sincronizar (build viejo / datos inválidos) y no se
    // reintentan más. Se auto-descartan a los 7 días (cleanupOldFailed). Las
    // mostramos discretas: el cajero no tiene nada para hacer con ellas.
    icon = <AlertCircle className="h-3.5 w-3.5" />;
    label = `${failed} con error`;
    color = 'text-muted-foreground bg-muted border-border';
    title = `${failed} operación(es) de una sesión vieja no se pudieron sincronizar. Se descartan solas en unos días — no requieren acción.`;
  } else {
    icon = <CheckCircle2 className="h-3.5 w-3.5" />;
    label = 'Sincronizado';
    color = 'text-emerald-700 bg-emerald-500/10 border-emerald-500/30 dark:text-emerald-400';
    title = state.lastSyncAt
      ? `Último sync: ${new Date(state.lastSyncAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`
      : 'Todo sincronizado';
  }

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium select-none',
        color,
      )}
    >
      {icon}
      {label}
    </span>
  );
}
