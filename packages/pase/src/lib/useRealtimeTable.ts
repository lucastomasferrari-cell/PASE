import { useEffect, useRef } from "react";
import { useAuth } from "./auth";
import { db } from "./supabase";

// useRealtimeTable — hook reusable para suscribirse a cambios en una tabla
// Postgres via Supabase Realtime y disparar un callback (típicamente la
// función `load()` que ya existe en cada pantalla CRUD).
//
// Reemplaza el patrón "cerrar sesión y volver a abrir para ver cambios
// hechos por otros usuarios". Cada change (INSERT/UPDATE/DELETE) en la
// tabla suscrita ejecuta `onChange` debounced.
//
// FILTROS:
//   - tenant_id se aplica AUTOMÁTICAMENTE si `scopeByTenant !== false`.
//     Default true. Si no hay user logueado, el hook no se suscribe.
//   - scopeByLocal: si true, filtra por el primer local del user (Realtime
//     no soporta in.(...) confiablemente con arrays grandes).
//   - extraFilter: string PostgREST-style, ej "estado=eq.activo".
//
// PERFORMANCE:
//   - Visibility API: refresca al volver visible la tab.
//   - Debounce 200ms: 5 events bursts → 1 callback.
//
// ERROR HANDLING:
//   - Fallback automático a polling 30s si Realtime falla.
//
// SEGURIDAD:
//   - RLS de Postgres se aplica al stream Realtime — defense in depth.
//
// Versión PASE: idéntica funcionalmente a la de COMANDA pero adaptada al
// shape del Usuario de este package (user.locales | user._locales).

// EVENTS_DEFAULT — referencia estable. Bug fix: si se usaba el array
// literal inline como default (`events = ["INSERT", "UPDATE", "DELETE"]`)
// React generaba un nuevo array en cada render → useEffect detectaba
// "cambio" → cleanup + re-suscribe constante. Con la migration NO
// aplicada en producción, cada nueva suscripción terminaba en
// CHANNEL_ERROR → activaba polling 30s → cleanup del próximo render lo
// cancelaba → loop de re-suscripciones costoso visible como titileo en
// pantallas con múltiples hooks (Compras tiene 3).
const EVENTS_DEFAULT: readonly ("INSERT" | "UPDATE" | "DELETE")[] = ["INSERT", "UPDATE", "DELETE"];

interface UseRealtimeTableOptions {
  table: string;
  onChange: () => void;
  scopeByTenant?: boolean;
  scopeByLocal?: boolean;
  extraFilter?: string;
  events?: readonly ("INSERT" | "UPDATE" | "DELETE")[];
  debounceMs?: number;
  fallbackPollMs?: number;
  enabled?: boolean;
}

// Helper puro testeable.
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
    channelName: `rt:${table}:${tenantId ?? "_"}:${localId ?? "_"}`,
    filter: filterParts.length > 0 ? filterParts.join("&") : undefined,
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

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const tenantId = scopeByTenant ? user?.tenant_id ?? null : null;
  // PASE expone locales como `locales` (legacy) o `_locales` (enriched).
  const userLocales = (user?.locales ?? user?._locales ?? []) as number[];
  const localId: number | null = scopeByLocal && userLocales.length > 0 ? userLocales[0] ?? null : null;

  useEffect(() => {
    if (!enabled) return;
    const config = buildRealtimeConfig({
      table, tenantId, localId, scopeByTenant, scopeByLocal, extraFilter,
    });
    if (!config) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let connectionFailed = false;

    function fireDebounced() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { onChangeRef.current(); }, debounceMs);
    }

    const { channelName, filter } = config;


    let channel: ReturnType<typeof db.channel> | null = null;
    try {
      channel = db.channel(channelName);
      for (const event of events) {
        channel = (channel as unknown as { on: (e: string, opts: object, cb: () => void) => typeof channel }).on(
          "postgres_changes",
          { event, schema: "public", table, ...(filter ? { filter } : {}) },
          () => fireDebounced(),
        );
      }
      channel!.subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (!connectionFailed) {
            connectionFailed = true;
            if (!pollTimer) {
              pollTimer = setInterval(() => onChangeRef.current(), fallbackPollMs);
            }
          }
        } else if (status === "SUBSCRIBED") {
          connectionFailed = false;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      });
    } catch {
      pollTimer = setInterval(() => onChangeRef.current(), fallbackPollMs);
    }

    // Visibility refresh: throttleado por instancia para no disparar bursts
    // de N reloads cuando hay N hooks en la misma pantalla. Si el callback
    // ya corrió hace <5s, ignorar.
    let lastVisibilityRefresh = 0;
    function handleVisibility() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefresh < 5000) return;
      lastVisibilityRefresh = now;
      onChangeRef.current();
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (channel) {
        try { db.removeChannel(channel); } catch { /* ya cerrado */ }
      }
    };
    // eventsKey: estabiliza la dep por valor — un caller que pase un array
    // literal nuevo cada render no causa re-corrida del effect si los
    // events son los mismos.
  }, [table, tenantId, localId, extraFilter, events.join(","), debounceMs, fallbackPollMs, enabled, scopeByTenant, scopeByLocal]); // eslint-disable-line react-hooks/exhaustive-deps
}
