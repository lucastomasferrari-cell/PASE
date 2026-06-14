// Helpers para encolar PendingOps en la cola local.
//
// El consumer típico es desde un repo o desde un service nuevo offline-aware
// (Fase 4). Por ejemplo:
//
//   // Abrir venta offline:
//   const localVentaId = crypto.randomUUID();
//   await ventasRepo.put({ id: localVentaId, ...payload }); // marca dirty
//   await enqueueOperation({
//     target: 'fn_abrir_venta_comanda',
//     op_type: 'rpc',
//     payload: { p_local_id: ..., p_mesa_id: ..., p_local_id_uuid: localVentaId, ... },
//   });
//
// El syncEngine va a procesar la cola en orden FIFO. La operación tiene
// un `id` que sirve como idempotency_key — si la subimos 2 veces, el server
// detecta el duplicado y no lo aplica.

import { getDb } from '../db/index';
import type { PendingOp, PendingOpType, ReconcileHint } from '../db/schema';

export interface EnqueueArgs {
  // Tabla para inserts/updates/deletes, o nombre de RPC para 'rpc'.
  target: string;
  op_type: PendingOpType;
  payload: unknown;
  // Si esta op depende de otra (FK), el id de la op padre. El sync engine
  // espera que el padre esté `synced` antes de subir esta.
  depends_on?: string | null;
  // Hint para idReconciliation (Fase 4.3): qué tempId local actualizar
  // cuando el server retorna el BIGINT real.
  reconcile?: ReconcileHint | null;
}

// Genera un UUID compatible con browsers viejos sin crypto.randomUUID.
function genUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback simple (no criptográficamente seguro pero único en práctica)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Encola una operación pendiente. Devuelve el id generado (sirve como
// idempotency_key cuando se haga el push).
export async function enqueueOperation(args: EnqueueArgs): Promise<string> {
  const op: PendingOp = {
    id: genUUID(),
    created_at: new Date().toISOString(),
    op_type: args.op_type,
    target: args.target,
    payload: args.payload,
    depends_on: args.depends_on ?? null,
    status: 'pending',
    retries: 0,
    reconcile: args.reconcile ?? null,
  };
  const db = await getDb();
  await db.put('pending_ops', op);
  return op.id;
}

// Lista las operaciones pendientes ordenadas por created_at ASC (FIFO).
// Excluye las `synced` y `failed` (failed = se reintentaron N veces y
// quedaron requiriendo intervención manual).
export async function listPendingOps(): Promise<PendingOp[]> {
  const db = await getDb();
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  return all
    .filter((op) => op.status === 'pending' || op.status === 'syncing')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Marca una op como en proceso de sync (para que otra ejecución concurrente
// del syncEngine no la tome a la vez).
export async function markSyncing(opId: string): Promise<void> {
  const db = await getDb();
  const op = (await db.get('pending_ops', opId)) as PendingOp | undefined;
  if (!op) return;
  op.status = 'syncing';
  op.last_attempt_at = new Date().toISOString();
  await db.put('pending_ops', op);
}

// Marca una op como sincronizada con éxito. La fila se elimina de la cola
// después de N días (cleanup separado) — por ahora la dejamos.
// `serverResult` (opcional) es el data que retornó la RPC — se usa para
// reconciliar tempIds locales con BIGINT del server.
export async function markSynced(opId: string, serverResult?: unknown): Promise<void> {
  const db = await getDb();
  const op = (await db.get('pending_ops', opId)) as PendingOp | undefined;
  if (!op) return;
  op.status = 'synced';
  op.last_attempt_at = new Date().toISOString();
  op.last_error = null;
  if (serverResult !== undefined) {
    op.server_result = serverResult;
  }
  await db.put('pending_ops', op);
}

// Marca una op como fallida. Si retries < MAX_RETRIES, queda en 'pending'
// para reintentar; si llega al máximo, queda 'failed' y requiere
// intervención manual (UI de "Operaciones rotas").
const MAX_RETRIES = 5;

// Errores donde reintentar JAMÁS va a funcionar — el server siempre va a
// responder lo mismo. Bug Lucas 2026-06-11: una op con payload que no
// matcheaba la firma de fn_anular_venta_comanda_offline (PGRST202 = 404)
// reintentó 5 veces a lo largo de horas spameando la consola.
//   - PGRST202: función no encontrada / argumentos no matchean la firma
//   - PGRST204: columna inexistente
//   - 22P02: valor con sintaxis inválida para el tipo (ej: uuid malformado)
export function isPermanentSyncError(errorMsg: string): boolean {
  return /PGRST202|PGRST204|Could not find the function|22P02|invalid input syntax/i.test(errorMsg);
}

export async function markFailed(opId: string, errorMsg: string): Promise<void> {
  const db = await getDb();
  const op = (await db.get('pending_ops', opId)) as PendingOp | undefined;
  if (!op) return;
  op.retries += 1;
  op.last_attempt_at = new Date().toISOString();
  op.last_error = errorMsg;
  // Error permanente → failed directo, sin quemar reintentos.
  op.status = (op.retries >= MAX_RETRIES || isPermanentSyncError(errorMsg)) ? 'failed' : 'pending';
  await db.put('pending_ops', op);
}

// Backoff exponencial para reintentos. Devuelve los ms a esperar antes
// del próximo intento basado en el número de retries.
//   0 retries → 0 ms (inmediato)
//   1 retry  → 5s
//   2 retry  → 30s
//   3 retry  → 5min
//   4 retry  → 30min
//   5+ retry → 1h (cap)
export function backoffMs(retries: number): number {
  if (retries <= 0) return 0;
  const backoffs = [5_000, 30_000, 300_000, 1_800_000, 3_600_000];
  return backoffs[Math.min(retries - 1, backoffs.length - 1)] ?? 3_600_000;
}

// Cuenta ops pendientes (para mostrar en SyncStatus).
export async function pendingCount(): Promise<number> {
  const ops = await listPendingOps();
  return ops.length;
}

// Cuenta ops fallidas que requieren intervención manual.
export async function failedCount(): Promise<number> {
  const db = await getDb();
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  return all.filter((op) => op.status === 'failed').length;
}

// AUDIT F5B#1: si el browser muere a mitad de un push (battery 0%, tab
// crash, etc.), las ops quedan en estado 'syncing' indefinidamente — no
// las vuelve a tomar el próximo ciclo porque listPendingOps filtra por
// status='pending'. Esta function resetea esas ops huérfanas a 'pending'
// para que se reintenten. Se llama desde syncEngine.start().
export async function resetSyncingOpsAtBoot(): Promise<number> {
  const db = await getDb();
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  let reset = 0;
  for (const op of all) {
    if (op.status === 'syncing') {
      op.status = 'pending';
      op.last_error = 'reset_at_boot: op estaba en syncing al iniciar engine';
      await db.put('pending_ops', op);
      reset++;
    }
  }
  return reset;
}

// Higiene al boot: ops pending/syncing con más de N días son basura de una
// sesión vieja (ej: pestaña POS abierta 9 días con un build viejo que dejó
// 13 ops imposibles de sincronizar — caso Lucas 2026-06-11). Las marcamos
// `failed` para que dejen de reintentarse y de contar como "pendientes";
// no las borramos así quedan inspeccionables en la UI de operaciones rotas.
// Se llama desde syncEngine.start().
const MAX_PENDING_AGE_DAYS = 3;

export async function expireStalePendingOps(): Promise<number> {
  const db = await getDb();
  const cutoff = Date.now() - MAX_PENDING_AGE_DAYS * 24 * 60 * 60 * 1000;
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  let expired = 0;
  for (const op of all) {
    if (op.status !== 'pending' && op.status !== 'syncing') continue;
    if (new Date(op.created_at).getTime() >= cutoff) continue;
    op.status = 'failed';
    op.last_error = `expired_at_boot: op pendiente hace más de ${MAX_PENDING_AGE_DAYS} días, no se reintenta más`;
    await db.put('pending_ops', op);
    expired++;
  }
  return expired;
}

// Cleanup: elimina ops `synced` con más de N días. Llamar periódicamente
// (cron del frontend o al cerrar turno) para no acumular history.
const KEEP_SYNCED_DAYS = 7;

export async function cleanupOldSynced(): Promise<number> {
  const db = await getDb();
  const cutoff = Date.now() - KEEP_SYNCED_DAYS * 24 * 60 * 60 * 1000;
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  let removed = 0;
  for (const op of all) {
    if (op.status === 'synced' && new Date(op.created_at).getTime() < cutoff) {
      await db.delete('pending_ops', op.id);
      removed++;
    }
  }
  return removed;
}

// Cleanup: elimina ops `failed` con más de N días. Una op failed NUNCA va a
// sincronizar (error permanente — payload de un build viejo que el server
// rechaza — o agotó los 5 reintentos). No hay UI para resolverlas, así que
// mantenerlas para siempre solo infla el contador del badge (caso Lucas
// 2026-06-13: 13 ops rotas de una pestaña vieja seguían contando como
// "pendientes" indefinidamente). Las dejamos unos días por si hace falta
// inspeccionarlas en consola, después se descartan solas. Se llama al boot.
const KEEP_FAILED_DAYS = 7;

export async function cleanupOldFailed(): Promise<number> {
  const db = await getDb();
  const cutoff = Date.now() - KEEP_FAILED_DAYS * 24 * 60 * 60 * 1000;
  const all = (await db.getAll('pending_ops')) as PendingOp[];
  let removed = 0;
  for (const op of all) {
    if (op.status === 'failed' && new Date(op.created_at).getTime() < cutoff) {
      await db.delete('pending_ops', op.id);
      removed++;
    }
  }
  return removed;
}
