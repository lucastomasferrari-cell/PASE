import { useEffect, useRef } from 'react';
import { useAuth } from './auth';
import { db } from './supabase';

// useRealtimeTable — hook reusable para suscribirse a cambios en una tabla
// Postgres via Supabase Realtime y dispararse un callback (típicamente la
// función `reload()` que ya existe en cada pantalla CRUD).
//
// Reemplaza el patrón "cerrar sesión y volver a abrir para ver cambios
// hechos por otros usuarios". Cada change (INSERT/UPDATE/DELETE) en la
// tabla suscrita ejecuta `onChange` debounced.
//
// FILTROS:
//   - tenant_id se aplica AUTOMÁTICAMENTE si la tabla tiene la columna
//     y `scopeByTenant !== false`. Default true. Si no hay user logueado,
//     el hook no se suscribe (espera).
//   - locales: si `scopeByLocales=true`, se filtra por el primer local del
//     user (Realtime no soporta `in.(...)` confiablemente con arrays
//     grandes — para multi-local, usar callback que ignora cambios fuera
//     de scope o suscribirse N veces). Default false (suscripción amplia
//     por tenant).
//   - extraFilter: string PostgREST-style ej "estado=eq.activo".
//
// PERFORMANCE:
//   - Visibility API: pausa la suscripción cuando la pestaña está oculta.
//     Al volver visible, dispara onChange inmediatamente para sincronizar.
//   - Debounce 200ms: si llegan 5 events seguidos (bulk insert), invoca
//     onChange 1 sola vez al final.
//
// ERROR HANDLING:
//   - Si la suscripción falla (Realtime offline / sin permisos), el hook
//     hace fallback a polling cada 30s del onChange. Silente.
//
// SEGURIDAD:
//   - Las RLS policies del Postgres se aplican al stream Realtime también.
//     Aunque el filtro tenant_id se olvide, las filas de OTROS tenants no
//     llegan al cliente (defense in depth).

// EVENTS_DEFAULT — referencia estable. Bug fix: si se usaba el array
// literal inline como default React generaba un nuevo array en cada
// render → useEffect detectaba "cambio" → cleanup + re-suscribe constante
// → con la migration NO aplicada en producción, cada nueva suscripción
// terminaba en CHANNEL_ERROR → loop visible como titileo en pantallas
// con múltiples hooks (Compras tiene 3).
const EVENTS_DEFAULT: readonly ('INSERT' | 'UPDATE' | 'DELETE')[] = ['INSERT', 'UPDATE', 'DELETE'];

interface UseRealtimeTableOptions {
  /** Nombre de la tabla en Postgres (sin schema). */
  table: string;
  /** Callback que dispara cuando hay cambio. Típicamente reload() de la pantalla. */
  onChange: () => void;
  /** Filtrar por tenant_id automáticamente. Default true. */
  scopeByTenant?: boolean;
  /** Filtrar por primer local del user. Default false. */
  scopeByLocal?: boolean;
  /** Filtro PostgREST extra, ej: 'estado=eq.activo'. */
  extraFilter?: string;
  /** Eventos a escuchar. Default todos. */
  events?: readonly ('INSERT' | 'UPDATE' | 'DELETE')[];
  /** Debounce en ms para callback. Default 200. */
  debounceMs?: number;
  /** Polling fallback en ms si Realtime falla. Default 30000. */
  fallbackPollMs?: number;
  /** Activar/desactivar el hook (útil para condicionarlo). Default true. */
  enabled?: boolean;
}

// Helper puro testeable sin React DOM. Calcula channelName + filter
// PostgREST a partir de las opciones + user actual. Retorna null si NO
// se debe suscribir (sin tenant cuando scopeByTenant=true).
export interface RealtimeSubscriptionConfig {
  channelName: string;
  filter: string | undefined;
}

export function buildRealtimeConfig(args: {
  table: string;
  tenantId: string | null;
  localId: number | null;
  scopeByTenant: boolean;
  scopeByLocal: boolean;
  extraFilter?: string;
}): RealtimeSubscriptionConfig | null {
  const { table, tenantId, localId, scopeByTenant, scopeByLocal, extraFilter } = args;
  if (scopeByTenant && !tenantId) return null;
  const filterParts: string[] = [];
  if (scopeByTenant && tenantId) filterParts.push(`tenant_id=eq.${tenantId}`);
  if (scopeByLocal && localId !== null) filterParts.push(`local_id=eq.${localId}`);
  if (extraFilter) filterParts.push(extraFilter);
  return {
    channelName: `rt:${table}:${tenantId ?? '_'}:${localId ?? '_'}`,
    filter: filterParts.length > 0 ? filterParts.join('&') : undefined,
  };
}

export function useRealtimeTable({
  table,
  onChange,
  scopeByTenant = true,
  scopeByLocal = false,
  extraFilter,
  events = EVENTS_DEFAULT,
  debounceMs = 200,
  fallbackPollMs = 30000,
  enabled = true,
}: UseRealtimeTableOptions): void {
  const { user } = useAuth();
  const onChangeRef = useRef(onChange);

  // Mantener fn más reciente sin recrear suscripción.
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Derivar tenant + local solo cuando user cambia. localId puede ser
  // undefined si scopeByLocal=false; en ese caso no se filtra por local.
  const tenantId = scopeByTenant ? user?.tenant_id ?? null : null;
  const localId: number | null = scopeByLocal && user?.locales && user.locales.length > 0
    ? user.locales[0] ?? null
    : null;

  useEffect(() => {
    if (!enabled) return;
    const config = buildRealtimeConfig({
      table, tenantId, localId, scopeByTenant, scopeByLocal, extraFilter,
    });
    if (!config) return; // sin tenant cuando se requiere → no suscribir

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let connectionFailed = false;

    function fireDebounced() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        onChangeRef.current();
      }, debounceMs);
    }

    const { channelName, filter } = config;

    let channel: ReturnType<typeof db.channel> | null = null;
    try {
      channel = db.channel(channelName);
      for (const event of events) {
        // postgres_changes es el tipo de event que Supabase Realtime expone
        // para CDC. El generic complicado de supabase-js v2 hace que el
        // tipado preciso sea verboso — usamos el cast amplio.
        channel = (channel as unknown as { on: (e: string, opts: object, cb: () => void) => typeof channel }).on(
          'postgres_changes',
          {
            event,
            schema: 'public',
            table,
            ...(filter ? { filter } : {}),
          },
          () => fireDebounced(),
        );
      }
      channel!.subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Activar fallback polling si la conexión falla.
          if (!connectionFailed) {
            connectionFailed = true;
            if (!pollTimer) {
              pollTimer = setInterval(() => onChangeRef.current(), fallbackPollMs);
            }
          }
        } else if (status === 'SUBSCRIBED') {
          // Conexión OK: cancelar polling si estaba activo.
          connectionFailed = false;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      });
    } catch {
      // Si el subscribe sincroniza falla por algún motivo, fallback polling.
      pollTimer = setInterval(() => onChangeRef.current(), fallbackPollMs);
    }

    // Visibility refresh: throttleado por instancia para no disparar bursts
    // de N reloads cuando hay N hooks suscritos en la misma pantalla.
    let lastVisibilityRefresh = 0;
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilityRefresh < 5000) return;
      lastVisibilityRefresh = now;
      onChangeRef.current();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (channel) {
        try { db.removeChannel(channel); } catch { /* ya cerrado */ }
      }
    };
    // events.join(',') estabiliza la dep por valor — el array literal del
    // caller cambia referencia cada render, el string sí es comparable.
  }, [table, tenantId, localId, extraFilter, events.join(','), debounceMs, fallbackPollMs, enabled, scopeByTenant, scopeByLocal]);
}
