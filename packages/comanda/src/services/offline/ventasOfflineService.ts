// ventasOfflineService — operaciones de ventas que escriben PRIMERO local
// y encolan para sync con cloud. Funciona online y offline transparente.
//
// Patrón sin migrar PKs (mantiene BIGINT en server, agrega UUID client-side
// como idempotency_key). Ver FASE_3_MIGRATION_UUIDS_PLAN.md para detalle.
//
// Flow típico de abrirVenta offline:
//   1. Client genera UUID local (random, hard-uniq garantizado)
//   2. Insert en IndexedDB con id_local=UUID + estado=abierta
//   3. Encola PendingOp con target='fn_abrir_venta_comanda' + payload + uuid
//   4. Si online: pushQueue procesa inmediato, server retorna BIGINT real
//   5. Reconciliamos: borramos row local con UUID, insertamos con BIGINT
//   6. Si offline: queda en cola, se procesa al volver
//
// La UI consume estas funciones igual sin saber si está online o offline.
// El syncEngine se encarga del resto.

import { ventasRepo, ventasItemsRepo } from '@/lib/db/repositories/ventasRepo';
import { enqueueOperation } from '@/lib/sync/operations';
import { syncEngine } from '@/lib/sync/syncEngine';
import type { LocalVentaPos, LocalVentaItem } from '@/lib/db/schema';

// Para PKs locales temporales mientras esperan el BIGINT del server.
// Usamos number con valor negativo MUY grande (al estilo BSON ObjectId
// negativo) para diferenciar visualmente de los BIGINTs reales positivos.
// Cuando llega el BIGINT real del server, reconciliamos.
let _tempIdCounter = -1_000_000_000;
function nextTempId(): number {
  return _tempIdCounter--;
}

function genUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export interface AbrirVentaArgs {
  tenantId: string;
  localId: number;
  canalId: number;
  modo: 'salon' | 'mostrador' | 'delivery' | 'retiro';
  mesaId?: number | null;
  mozoId?: string | null;
  cajeroId?: string | null;
  clienteId?: number | null;
  covers?: number;
  tabNombre?: string | null;
}

export interface AbrirVentaResult {
  tempVentaId: number;     // id local temporal (negativo)
  idempotencyUuid: string; // UUID client-side para dedup en server
  queuedOpId: string;      // id de la PendingOp en la cola (debugging)
}

// Abrir venta: local-first. Devuelve un tempId que la UI puede usar para
// navegar a /pos/venta/<id>. Cuando el sync confirma, el repo actualiza
// el id real (Fase 4.2).
export async function abrirVentaOffline(args: AbrirVentaArgs): Promise<AbrirVentaResult> {
  const tempId = nextTempId();
  const idempotencyUuid = genUUID();
  const now = new Date().toISOString();

  const venta: LocalVentaPos = {
    id: tempId,
    tenant_id: args.tenantId,
    local_id: args.localId,
    canal_id: args.canalId,
    numero_local: 0,           // server-assigned; placeholder local
    mesa_id: args.mesaId ?? null,
    cajero_id: args.cajeroId ?? null,
    mozo_id: args.mozoId ?? null,
    cliente_id: args.clienteId ?? null,
    modo: args.modo,
    estado: 'abierta',
    covers: args.covers ?? null,
    abierta_at: now,
    cobrada_at: null,
    anulada_at: null,
    enviada_at: null,
    subtotal: 0,
    descuento_total: 0,
    propina: 0,
    total: 0,
    coursing_auto: false,
    notas: null,
    cliente_nombre: null,
    tab_nombre: args.tabNombre ?? null,
    pagada: false,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  } as unknown as LocalVentaPos;

  await ventasRepo.put(venta);
  const queuedOpId = await enqueueOperation({
    target: 'fn_abrir_venta_comanda',
    op_type: 'rpc',
    payload: {
      p_local_id: args.localId,
      p_canal_id: args.canalId,
      p_modo: args.modo,
      p_mesa_id: args.mesaId ?? null,
      p_mozo_id: args.mozoId ?? null,
      p_cajero_id: args.cajeroId ?? null,
      p_cliente_id: args.clienteId ?? null,
      p_covers: args.covers ?? null,
      p_tab_nombre: args.tabNombre ?? null,
      // El server usa este UUID para detectar duplicados + para devolver
      // el BIGINT real correlacionado con esta op.
      p_idempotency_uuid: idempotencyUuid,
    },
    reconcile: { kind: 'venta', tempVentaId: tempId },
  });

  // Trigger push inmediato si está online (no espera el ciclo de 30s)
  void syncEngine.triggerPush();

  return { tempVentaId: tempId, idempotencyUuid, queuedOpId };
}

export interface AgregarItemArgs {
  ventaId: number;            // id local (puede ser tempId negativo o BIGINT real)
  itemId: number;
  cantidad: number;
  precioUnitario: number;
  curso?: number;
  modificadores?: Array<{ nombre: string; precio_extra: number; modifier_id?: number }>;
  notas?: string | null;
  cargadoPor?: string | null;
  tenantId: string;
  localId: number;
}

export interface AgregarItemResult {
  tempItemId: number;
  idempotencyUuid: string;
  queuedOpId: string;
}

// Agregar item: similar a abrir venta. Si la venta padre es tempId
// (negativo), el server NO la conoce todavía — encadenamos la op
// con depends_on. El pushQueue espera a que el padre esté synced antes
// de procesar el child.
export async function agregarItemOffline(args: AgregarItemArgs): Promise<AgregarItemResult> {
  const tempItemId = nextTempId();
  const idempotencyUuid = genUUID();
  const now = new Date().toISOString();

  const subtotal = args.cantidad * args.precioUnitario;

  const item: LocalVentaItem = {
    id: tempItemId,
    tenant_id: args.tenantId,
    local_id: args.localId,
    venta_id: args.ventaId,
    item_id: args.itemId,
    cantidad: args.cantidad,
    precio_unitario: args.precioUnitario,
    subtotal,
    descuento: 0,
    modificadores: args.modificadores ?? null,
    curso: args.curso ?? 1,
    combo_padre_id: null,
    es_combo_padre: false,
    estado: 'hold',
    enviado_at: null,
    listo_at: null,
    anulado_at: null,
    anulado_motivo: null,
    notas: args.notas ?? null,
    cargado_por: args.cargadoPor ?? null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  } as unknown as LocalVentaItem;

  await ventasItemsRepo.put(item);

  // Update total local de la venta (optimistic — el server recalcula al
  // procesar la RPC)
  const venta = await ventasRepo.getById(args.ventaId);
  if (venta) {
    venta.subtotal = Number(venta.subtotal) + subtotal;
    venta.total = Number(venta.total) + subtotal;
    venta.updated_at = now;
    await ventasRepo.put(venta);
  }

  // Si la venta padre tiene id temporal (negativo), tenemos que esperar
  // al sync de la venta antes de procesar el item.
  // En el patrón actual el server-side no soporta esta encadenación
  // automática — necesita la RPC fn_agregar_item_comanda con
  // p_venta_idempotency_uuid en lugar de p_venta_id. Ver Fase 4.2.
  const queuedOpId = await enqueueOperation({
    target: 'fn_agregar_item_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: args.ventaId > 0 ? args.ventaId : null,
      // Si la venta es local-only, mandamos su UUID para que el server
      // resuelva el venta_id real (requiere actualización de la RPC).
      p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
      p_item_id: args.itemId,
      p_cantidad: args.cantidad,
      p_precio_unitario: args.precioUnitario,
      p_curso: args.curso ?? 1,
      p_modificadores: args.modificadores ?? null,
      p_notas: args.notas ?? null,
      p_cargado_por: args.cargadoPor ?? null,
      p_idempotency_uuid: idempotencyUuid,
    },
    reconcile: { kind: 'venta_item', tempItemId, tempVentaId: args.ventaId < 0 ? args.ventaId : null },
  });

  void syncEngine.triggerPush();

  return { tempItemId, idempotencyUuid, queuedOpId };
}

// Mandar curso: marca todos los items en hold del curso como enviado
// en local, encola la RPC server-side.
export async function mandarCursoOffline(ventaId: number, curso: number): Promise<{ count: number; queuedOpId: string }> {
  const items = await ventasItemsRepo.listByVenta(ventaId);
  const toSend = items.filter((i) => i.estado === 'hold' && i.curso === curso);
  const now = new Date().toISOString();

  let sentCount = 0;
  for (const it of toSend) {
    const stayFlag = (it as unknown as { stay_until_release?: boolean }).stay_until_release;
    if (stayFlag) continue;
    it.estado = 'enviado';
    it.enviado_at = now;
    it.updated_at = now;
    await ventasItemsRepo.put(it);
    sentCount++;
  }

  const queuedOpId = await enqueueOperation({
    target: 'fn_mandar_curso_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: ventaId > 0 ? ventaId : null,
      p_venta_idempotency_uuid: ventaId < 0 ? '__pending_parent__' : null,
      p_curso: curso,
    },
  });

  void syncEngine.triggerPush();
  return { count: sentCount, queuedOpId };
}

// Helpers para el caller: detectar si una venta tiene cambios pendientes
// de sincronizar (útil para mostrar indicador en UI).
export async function ventaHasPendingSync(ventaId: number): Promise<boolean> {
  const venta = await ventasRepo.getById(ventaId);
  if (!venta) return false;
  if ((venta as unknown as { _local_dirty?: boolean })._local_dirty) return true;
  const items = await ventasItemsRepo.listByVenta(ventaId);
  return items.some((i) => (i as unknown as { _local_dirty?: boolean })._local_dirty);
}
