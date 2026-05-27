// useRealtimeRow — versión incremental de useRealtimeTable (F3C refactor).
//
// `useRealtimeTable` ejecuta un callback void → el caller hace reload completo
// de toda la tabla. Para tablas grandes esto es N+1 querias: 1 trigger Realtime
// → 1 SELECT * FROM tabla → re-render con el dataset completo.
//
// Este hook expone el ROW que cambió (con event type) → el caller hace MERGE
// incremental en su state local:
//
//   const [rows, setRows] = useState<Movimiento[]>([])
//   useRealtimeRow({
//     table: 'movimientos',
//     onRow: (event, row) => {
//       setRows(prev => {
//         if (event === 'DELETE') return prev.filter(r => r.id !== row.id);
//         const idx = prev.findIndex(r => r.id === row.id);
//         if (idx >= 0) { const copy = [...prev]; copy[idx] = row; return copy; }
//         return [row, ...prev];
//       });
//     },
//   });
//
// Beneficios vs reload completo:
//   - 0 queries adicionales por event Realtime
//   - Sin titileo de la lista (no se desmonta + re-rendera)
//   - Escala con N rows sin crecer el costo por evento
//
// Convención adoptada 2026-05-27 (audit F3C): para listados de filas mutables
// (movimientos, ventas, facturas, gastos, etc.) preferir `useRealtimeRow`.
// `useRealtimeTable` sigue válido para tablas chicas (catálogos, config, etc).

import { useEffect, useRef } from "react";
import { useAuth } from "./auth";
import { db } from "./supabase";
import { buildRealtimeConfig } from "./useRealtimeTable";

export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";

interface UseRealtimeRowOptions<T> {
  table: string;
  /** Callback que recibe el evento + el row cambiado (typed). */
  onRow: (event: RealtimeEvent, row: T) => void;
  scopeByTenant?: boolean;
  scopeByLocal?: boolean;
  extraFilter?: string;
  events?: readonly RealtimeEvent[];
  fallbackPollMs?: number;
  /** Callback opcional invocado al hacer fallback a polling (si Realtime falla). */
  onPollFallback?: () => void;
  enabled?: boolean;
}

const EVENTS_DEFAULT: readonly RealtimeEvent[] = ["INSERT", "UPDATE", "DELETE"];

interface PostgresChangePayload<T> {
  eventType: RealtimeEvent;
  new: T;
  old: T;
}

export function useRealtimeRow<T extends { id?: unknown }>({
  table,
  onRow,
  scopeByTenant = true,
  scopeByLocal = false,
  extraFilter,
  events = EVENTS_DEFAULT,
  fallbackPollMs = 30000,
  onPollFallback,
  enabled = true,
}: UseRealtimeRowOptions<T>): void {
  const { user } = useAuth();
  const onRowRef = useRef(onRow);
  const onPollRef = useRef(onPollFallback);

  useEffect(() => { onRowRef.current = onRow; }, [onRow]);
  useEffect(() => { onPollRef.current = onPollFallback; }, [onPollFallback]);

  const tenantId = scopeByTenant ? user?.tenant_id ?? null : null;
  const userLocales = (user?.locales ?? user?._locales ?? []) as number[];
  const localId: number | null = scopeByLocal && userLocales.length > 0 ? userLocales[0] ?? null : null;

  useEffect(() => {
    if (!enabled) return;
    const config = buildRealtimeConfig({
      table, tenantId, localId, scopeByTenant, scopeByLocal, extraFilter,
    });
    if (!config) return;

    const { channelName, filter } = config;
    let channel: ReturnType<typeof db.channel> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let connectionFailed = false;

    function fireRow(event: RealtimeEvent, payload: PostgresChangePayload<T>) {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // DELETE entrega el row removido en `old`; INSERT/UPDATE en `new`.
      const row = event === "DELETE" ? payload.old : payload.new;
      if (row) onRowRef.current(event, row);
    }

    try {
      channel = db.channel(channelName);
      for (const event of events) {
        channel = (channel as unknown as { on: (e: string, opts: object, cb: (p: PostgresChangePayload<T>) => void) => typeof channel }).on(
          "postgres_changes",
          { event, schema: "public", table, ...(filter ? { filter } : {}) },
          (payload) => fireRow(event, payload),
        );
      }
      channel!.subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (!connectionFailed) {
            connectionFailed = true;
            // Fallback: el caller debe definir cómo recargar (no podemos
            // suplir filas individuales sin saber la query).
            if (!pollTimer && onPollRef.current) {
              pollTimer = setInterval(() => onPollRef.current?.(), fallbackPollMs);
            }
          }
        } else if (status === "SUBSCRIBED") {
          connectionFailed = false;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      });
    } catch {
      if (onPollRef.current) {
        pollTimer = setInterval(() => onPollRef.current?.(), fallbackPollMs);
      }
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (channel) {
        try { db.removeChannel(channel); } catch { /* ignore */ }
      }
    };
  }, [table, tenantId, localId, extraFilter, events.join(","), fallbackPollMs, enabled, scopeByTenant, scopeByLocal]); // eslint-disable-line react-hooks/exhaustive-deps
}
