// idReconciliation — convierte tempIds locales (negativos) en BIGINT reales
// del server después de sincronizar exitosamente.
//
// Flow:
//   1. Client crea venta offline con tempId = -1234567890
//   2. Items asociados a esa venta tienen venta_id = -1234567890
//   3. pushQueue ejecuta RPC `fn_abrir_venta_comanda_offline(...)`
//   4. Server retorna BIGINT real = 5421
//   5. Esta función:
//      a. Borra venta local con id = -1234567890
//      b. Crea venta local con id = 5421 (copia del row anterior)
//      c. Actualiza items con venta_id = -1234567890 → venta_id = 5421
//      d. Actualiza pagos con venta_id = -1234567890 → venta_id = 5421
//      e. Actualiza referencias en otros tempIds pendientes en la cola
//         (ops futuras que ya tenían el tempId negativo en su payload)
//
// La función es idempotente: si por algún motivo se ejecuta 2 veces, no
// rompe (la segunda no encuentra el tempId ya reconciliado).

import { getDb } from '../db/index';
import type { ReconcileHint, PendingOp } from '../db/schema';

interface ReconcileMapping {
  tempId: number;
  realId: number;
}

export async function reconcileFromServerResult(
  hint: ReconcileHint,
  serverResult: unknown,
): Promise<void> {
  // Extraer BIGINT del result. Las RPCs `_offline` devuelven directamente
  // un number (data), no un objeto. Sanidad por las dudas.
  const realId = extractBigint(serverResult);
  if (realId == null || realId <= 0) {
    throw new Error(`server_result no es BIGINT válido: ${JSON.stringify(serverResult)}`);
  }

  switch (hint.kind) {
    case 'venta':
      await reconcileVenta({ tempId: hint.tempVentaId, realId });
      break;
    case 'venta_item':
      await reconcileVentaItem({ tempId: hint.tempItemId, realId });
      // Si la venta padre también era temp, actualizar venta_id del item
      // ya fue resuelto cuando se reconcilió la venta. Acá solo el item id.
      break;
    case 'venta_pago':
      await reconcileVentaPago({ tempId: hint.tempPagoId, realId });
      break;
    case 'none':
      // No-op
      break;
  }
}

function extractBigint(result: unknown): number | null {
  if (typeof result === 'number') return result;
  if (typeof result === 'string') {
    const n = Number(result);
    return Number.isFinite(n) ? n : null;
  }
  // Algunos drivers retornan { data: N } o un array — manejamos los comunes
  if (Array.isArray(result) && result.length > 0) {
    return extractBigint(result[0]);
  }
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    // PostgREST a veces retorna como { id: N } o como N directo
    if ('id' in obj) return extractBigint(obj.id);
  }
  return null;
}

// Si el tempId es positivo, no hay nada que reconciliar — la op fue
// online normal sin tempId temporal. Solo reconciliamos cuando tempId < 0.
function isTempId(id: number): boolean {
  return id < 0;
}

async function reconcileVenta(map: ReconcileMapping): Promise<void> {
  if (!isTempId(map.tempId)) return;

  // 1. Mover el row de venta del tempId al realId
  await moveRow('ventas_pos', map.tempId, map.realId);

  // 2. Actualizar todos los venta_pos_items con venta_id = tempId → realId
  await updateForeignKey('ventas_pos_items', 'venta_id', map.tempId, map.realId);

  // 3. Actualizar todos los venta_pos_pagos con venta_id = tempId → realId
  await updateForeignKey('ventas_pos_pagos', 'venta_id', map.tempId, map.realId);

  // 4. Actualizar pending_ops que tenían el tempId en su payload
  //    (ops aún pendientes que referenciaban la venta temp)
  await rewritePendingOpsPayloadVentaId(map.tempId, map.realId);

  // 5. Disparar evento para que componentes que estaban viendo /pos/venta/<tempId>
  //    sepan que ahora el id es <realId> y navegue (la UI escucha esto).
  emitReconcileEvent({ kind: 'venta', tempId: map.tempId, realId: map.realId });
}

async function reconcileVentaItem(map: ReconcileMapping): Promise<void> {
  if (!isTempId(map.tempId)) return;
  await moveRow('ventas_pos_items', map.tempId, map.realId);
  // Las ventas_pos_overrides referencian venta_item_id, también actualizamos
  // (cuando esa tabla tenga repo local, agregar acá).
  emitReconcileEvent({ kind: 'venta_item', tempId: map.tempId, realId: map.realId });
}

async function reconcileVentaPago(map: ReconcileMapping): Promise<void> {
  if (!isTempId(map.tempId)) return;
  await moveRow('ventas_pos_pagos', map.tempId, map.realId);
  emitReconcileEvent({ kind: 'venta_pago', tempId: map.tempId, realId: map.realId });
}

// ─── Helpers compartidos ────────────────────────────────────────────────────

type StoreWithKeyPathId =
  | 'ventas_pos' | 'ventas_pos_items' | 'ventas_pos_pagos';

async function moveRow(store: StoreWithKeyPathId, tempId: number, realId: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  const old = await tx.store.get(tempId);
  if (!old) {
    // Ya no existe — alguien borró o ya se reconcilió. Idempotente.
    await tx.done;
    return;
  }
  // Si ya existe row con realId, no sobrescribir — el server ya respondió
  // antes (este es un retry/duplicate).
  const already = await tx.store.get(realId);
  if (already) {
    // Sacar la temp, dejar la real
    await tx.store.delete(tempId);
    await tx.done;
    return;
  }
  // Copia con el id nuevo + marcada como synced (no dirty)
  const copy = { ...old, id: realId, _local_dirty: false, _local_synced_at: new Date().toISOString() };
  await tx.store.put(copy);
  await tx.store.delete(tempId);
  await tx.done;
}

async function updateForeignKey(
  store: 'ventas_pos_items' | 'ventas_pos_pagos',
  fkField: 'venta_id',
  tempId: number,
  realId: number,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  const idx = tx.store.index('by_venta');
  let cursor = await idx.openCursor(IDBKeyRange.only(tempId));
  while (cursor) {
    const row = cursor.value as Record<string, unknown>;
    row[fkField] = realId;
    await cursor.update(row);
    cursor = await cursor.continue();
  }
  await tx.done;
}

async function rewritePendingOpsPayloadVentaId(tempId: number, realId: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('pending_ops', 'readwrite');
  const all = (await tx.store.getAll()) as PendingOp[];
  for (const op of all) {
    if (op.status !== 'pending' && op.status !== 'syncing') continue;
    const payload = op.payload as Record<string, unknown> | null;
    if (!payload) continue;
    // p_venta_id es el más común. Algunos endpoints futuros pueden tener
    // otras claves; las agregamos cuando aparezcan.
    if (payload.p_venta_id === tempId) {
      payload.p_venta_id = realId;
      // Sacar la marca de "padre pendiente"
      if (payload.p_venta_idempotency_uuid === '__pending_parent__') {
        payload.p_venta_idempotency_uuid = null;
      }
      await tx.store.put(op);
    }
  }
  await tx.done;
}

// ─── Event bus para que la UI escuche reconciliaciones ──────────────────────
// Cuando una venta temp pasa a id real, los componentes que están viewando
// /pos/venta/<tempId> necesitan saber para navegar a /pos/venta/<realId>.
// Usamos un custom event en window — simple y sin dependencias extras.

export interface ReconcileEvent {
  kind: 'venta' | 'venta_item' | 'venta_pago';
  tempId: number;
  realId: number;
}

export const RECONCILE_EVENT_NAME = 'comanda:reconcile-id';

function emitReconcileEvent(detail: ReconcileEvent): void {
  if (typeof window === 'undefined') return; // SSR / tests sin DOM
  window.dispatchEvent(new CustomEvent(RECONCILE_EVENT_NAME, { detail }));
}

// Hook helper opcional para components que quieran escuchar:
//
//   useEffect(() => {
//     const cleanup = listenReconcile((ev) => {
//       if (ev.kind === 'venta' && ev.tempId === ventaIdActual) {
//         navigate(`/pos/venta/${ev.realId}`, { replace: true });
//       }
//     });
//     return cleanup;
//   }, [ventaIdActual]);
export function listenReconcile(handler: (ev: ReconcileEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (e: Event) => {
    const ce = e as CustomEvent<ReconcileEvent>;
    handler(ce.detail);
  };
  window.addEventListener(RECONCILE_EVENT_NAME, wrapped);
  return () => window.removeEventListener(RECONCILE_EVENT_NAME, wrapped);
}
