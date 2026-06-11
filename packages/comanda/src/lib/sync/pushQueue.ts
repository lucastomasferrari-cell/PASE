// Push queue — procesa la cola de operaciones pendientes hacia el cloud.
//
// Diseño:
//   - FIFO con orden estricto (created_at ASC) para preservar causalidad
//     (no podés "modificar item" antes de "crear item").
//   - Operaciones con `depends_on` esperan a que el padre esté `synced`.
//   - Cada operación usa su `id` como idempotency_key cuando es soportado
//     por la RPC (las RPCs de PASE que tienen el patrón sunny-creek C1).
//   - Errores: retry con backoff exponencial (definido en operations.ts).
//     Si llega al máximo de retries (5), queda `failed` para resolución
//     manual.
//
// El syncEngine llama `processPushQueue` cada ~30s mientras hay conexión.
// También dispara on-demand cuando una nueva op se encola (push inmediato
// si online).

import { db as supabase } from '../supabase';
import {
  listPendingOps, markSyncing, markSynced, markFailed, backoffMs,
} from './operations';
import type { PendingOp } from '../db/schema';
import { getDb } from '../db/index';
import { reconcileFromServerResult } from './idReconciliation';

// Resultado de procesar una op individual.
type ProcessResult =
  | { status: 'ok'; data?: unknown }
  | { status: 'error'; message: string }
  | { status: 'skip'; reason: string };

// Procesa UNA operación contra el cloud. La función switchea por op_type
// y por target (qué tabla / RPC). Cuando agregues una RPC nueva offline-
// aware, agregá su case acá.
async function processOp(op: PendingOp): Promise<ProcessResult> {
  try {
    switch (op.op_type) {
      case 'rpc': {
        // Para RPCs, payload son los args. Le pasamos el id como
        // p_idempotency_key si la RPC lo acepta — el server-side detecta
        // duplicado y no aplica.
        //
        // Mapeo de RPCs offline-aware: las RPCs creadas en migration
        // 202605161400_idempotency_uuid_ventas.sql usan suffix `_offline`
        // y aceptan p_idempotency_uuid / p_venta_idempotency_uuid /
        // p_item_idempotency_uuid (varios kinds según la RPC).
        //
        // BUG FIX 2026-06-02 noche: la condición vieja solo miraba
        // p_idempotency_uuid. mandarCursoOffline + agregarItemOffline
        // pasan p_venta_idempotency_uuid pero no p_idempotency_uuid →
        // el push no agregaba sufijo → 404 contra fn_mandar_curso_comanda
        // (no existe) y fn_agregar_item_comanda (no es offline-aware).
        //
        // Fix: detectar CUALQUIER key que contenga 'idempotency_uuid' en
        // el payload. Eso captura todas las variantes.
        const payload = op.payload as Record<string, unknown>;
        const usesIdempotencyUuid = payload && Object.keys(payload).some(
          (k) => k.toLowerCase().includes('idempotency_uuid') && payload[k] != null,
        );
        const targetRpc = usesIdempotencyUuid && !op.target.endsWith('_offline')
          ? `${op.target}_offline`
          : op.target;
        const args = { ...payload, p_idempotency_key: op.id };
        const { data, error } = await supabase.rpc(targetRpc, args);
        if (error) {
          // Diagnóstico completo: rpc + claves enviadas + código PostgREST.
          // Sin esto un PGRST202 (404) solo mostraba "Failed to load
          // resource" en consola y era imposible saber qué payload exacto
          // falló (bug anular venta 11-jun). El código dentro del message
          // también permite a markFailed detectar errores permanentes.
          console.error('[pushQueue] RPC falló', {
            rpc: targetRpc, code: error.code, message: error.message,
            hint: error.hint, args,
          });
          return {
            status: 'error',
            message: `${error.code ?? ''}: ${error.message} [rpc=${targetRpc} keys=${Object.keys(args).join(',')}]`,
          };
        }
        return { status: 'ok', data };
      }
      case 'insert': {
        const { error } = await supabase.from(op.target).insert(op.payload as object);
        if (error) return { status: 'error', message: error.message };
        return { status: 'ok' };
      }
      case 'update': {
        const payload = op.payload as { id: string | number; patch: Record<string, unknown> };
        const { error } = await supabase
          .from(op.target).update(payload.patch).eq('id', payload.id);
        if (error) return { status: 'error', message: error.message };
        return { status: 'ok' };
      }
      case 'delete': {
        const payload = op.payload as { id: string | number };
        const { error } = await supabase.from(op.target).delete().eq('id', payload.id);
        if (error) return { status: 'error', message: error.message };
        return { status: 'ok' };
      }
      default:
        return { status: 'error', message: `op_type desconocido: ${op.op_type}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', message: msg };
  }
}

// Chequea si una op está bloqueada por su dependencia (padre todavía no
// synced). Si el padre falló o no existe, devuelve la op igual lista para
// procesar (la dependencia ya no es necesaria).
async function isBlocked(op: PendingOp): Promise<boolean> {
  if (!op.depends_on) return false;
  const db = await getDb();
  const parent = (await db.get('pending_ops', op.depends_on)) as PendingOp | undefined;
  if (!parent) return false; // padre no existe, no bloqueamos
  return parent.status === 'pending' || parent.status === 'syncing';
}

// Chequea si está en su ventana de backoff (no reintentar antes de tiempo).
function isBackoff(op: PendingOp): boolean {
  if (op.retries === 0) return false;
  if (!op.last_attempt_at) return false;
  const wait = backoffMs(op.retries);
  const since = Date.now() - new Date(op.last_attempt_at).getTime();
  return since < wait;
}

export interface PushResult {
  processed: number;
  ok: number;
  errors: number;
  skipped: number;
  durationMs: number;
}

// Procesa la cola completa una vez. Devuelve métricas.
// Procesamiento secuencial para preservar orden (FIFO + dependencias).
export async function processPushQueue(): Promise<PushResult> {
  const t0 = performance.now();
  const ops = await listPendingOps();
  let ok = 0, errors = 0, skipped = 0;

  for (const op of ops) {
    if (await isBlocked(op)) { skipped++; continue; }
    if (isBackoff(op)) { skipped++; continue; }

    await markSyncing(op.id);
    const res = await processOp(op);
    if (res.status === 'ok') {
      await markSynced(op.id, res.data);
      // Reconciliación tempId → BIGINT real cuando aplica.
      if (op.reconcile && op.reconcile.kind !== 'none' && res.data != null) {
        try {
          await reconcileFromServerResult(op.reconcile, res.data);
        } catch (err) {
          // Log pero no fallar la op: la op SÍ se sincronizó OK al cloud,
          // solo falló la reconciliación local. Próximo pull incremental
          // va a traer el row correcto.
          console.error('[pushQueue] reconciliación falló', op.id, err);
        }
      }
      ok++;
    } else if (res.status === 'error') {
      await markFailed(op.id, res.message);
      errors++;
    } else {
      // 'skip' — tratamos como no-procesado
      skipped++;
    }
  }

  return {
    processed: ops.length,
    ok, errors, skipped,
    durationMs: Math.round(performance.now() - t0),
  };
}
