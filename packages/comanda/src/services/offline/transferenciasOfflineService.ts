// transferenciasOfflineService — operaciones de mesas en modo offline:
//   - transferir mesa (cambiar mesa_id de una venta)
//   - unir 2 mesas (mover items de venta B → venta A, cerrar B)
//   - partir cuenta (crear venta nueva con items seleccionados de la original)
//
// Estas operaciones son más complejas porque tocan múltiples rows + a veces
// crean rows nuevos. Por eso la reconciliación necesita pensar en cascada.

import { ventasRepo, ventasItemsRepo } from '@/lib/db/repositories/ventasRepo';
import { enqueueOperation } from '@/lib/sync/operations';
import { syncEngine } from '@/lib/sync/syncEngine';

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

let _tempIdCounter = -3_000_000_000;
function nextTempId(): number {
  return _tempIdCounter--;
}

// ─── Transferir mesa ────────────────────────────────────────────────────────

export interface TransferirMesaArgs {
  ventaId: number;
  mesaDestinoId: number;
  // Bug 11-jun: la capa offline NO transportaba manager/motivo, pero la RPC
  // interna (fn_transferir_mesa_comanda) exige manager (MANAGER_REQUERIDO)
  // y audita en ventas_pos_overrides. Cierra la deuda "los _offline no
  // auditan manager_id" del 19-may.
  managerId: string;
  motivo: string;
}

export async function transferirMesaOffline(args: TransferirMesaArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  const venta = await ventasRepo.getById(args.ventaId);
  if (venta) {
    venta.mesa_id = args.mesaDestinoId;
    venta.updated_at = now;
    await ventasRepo.put(venta);
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_transferir_mesa_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: args.ventaId > 0 ? args.ventaId : null,
      p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
      p_mesa_destino_id: args.mesaDestinoId,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Unir mesas (B → A) ─────────────────────────────────────────────────────

export interface UnirMesasArgs {
  ventaDestinoId: number;
  ventaOrigenId: number;
  managerId: string;
  motivo: string;
}

export async function unirMesasOffline(args: UnirMesasArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  // Local: mover items de origen → destino, cerrar origen
  const itemsOrigen = await ventasItemsRepo.listByVenta(args.ventaOrigenId);
  for (const it of itemsOrigen) {
    it.venta_id = args.ventaDestinoId;
    it.updated_at = now;
    await ventasItemsRepo.put(it);
  }
  const ventaOrigen = await ventasRepo.getById(args.ventaOrigenId);
  if (ventaOrigen) {
    ventaOrigen.estado = 'anulada';
    ventaOrigen.updated_at = now;
    await ventasRepo.put(ventaOrigen);
  }
  const ventaDestino = await ventasRepo.getById(args.ventaDestinoId);
  if (ventaDestino) {
    const sumadoSubtotal = itemsOrigen.reduce((s, i) => s + Number(i.subtotal), 0);
    ventaDestino.subtotal = Number(ventaDestino.subtotal) + sumadoSubtotal;
    ventaDestino.total = Number(ventaDestino.total) + sumadoSubtotal;
    ventaDestino.updated_at = now;
    await ventasRepo.put(ventaDestino);
  }

  const queuedOpId = await enqueueOperation({
    target: 'fn_unir_mesas_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_destino_id: args.ventaDestinoId > 0 ? args.ventaDestinoId : null,
      p_venta_destino_idempotency_uuid: args.ventaDestinoId < 0 ? '__pending_parent__' : null,
      p_venta_origen_id: args.ventaOrigenId > 0 ? args.ventaOrigenId : null,
      p_venta_origen_idempotency_uuid: args.ventaOrigenId < 0 ? '__pending_parent__' : null,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Partir cuenta (crear venta nueva con items seleccionados) ──────────────

export interface PartirCuentaArgs {
  ventaOriginalId: number;
  itemsToMove: number[];   // ids de items que van a la venta nueva
  tenantId: string;
  localId: number;
  managerId: string;
  motivo: string;
}

export interface PartirCuentaResult {
  tempVentaNuevaId: number;
  queuedOpId: string;
}

export async function partirCuentaOffline(args: PartirCuentaArgs): Promise<PartirCuentaResult> {
  const now = new Date().toISOString();
  const ventaOriginal = await ventasRepo.getById(args.ventaOriginalId);
  if (!ventaOriginal) throw new Error('VENTA_NO_ENCONTRADA');

  // Crear venta nueva local
  const tempVentaNuevaId = nextTempId();
  // Cast a unknown→LocalVentaPos porque la spread con `estado: 'abierta'`
  // pierde el tipo literal EstadoVenta.
  const ventaNueva = {
    ...ventaOriginal,
    id: tempVentaNuevaId,
    numero_local: 0,
    mesa_id: null,
    subtotal: 0,
    descuento_total: 0,
    propina: 0,
    total: 0,
    created_at: now,
    updated_at: now,
    abierta_at: now,
    cobrada_at: null,
    estado: 'abierta' as const,
  } as unknown as typeof ventaOriginal;
  await ventasRepo.put(ventaNueva);

  // Mover items seleccionados
  let sumadoMovido = 0;
  for (const itemId of args.itemsToMove) {
    const it = await ventasItemsRepo.getById(itemId);
    if (!it) continue;
    sumadoMovido += Number(it.subtotal);
    it.venta_id = tempVentaNuevaId;
    it.updated_at = now;
    await ventasItemsRepo.put(it);
  }

  // Update totales
  ventaOriginal.subtotal = Math.max(0, Number(ventaOriginal.subtotal) - sumadoMovido);
  ventaOriginal.total = Math.max(0, Number(ventaOriginal.total) - sumadoMovido);
  ventaOriginal.updated_at = now;
  await ventasRepo.put(ventaOriginal);

  ventaNueva.subtotal = sumadoMovido;
  ventaNueva.total = sumadoMovido;
  await ventasRepo.put(ventaNueva);

  const queuedOpId = await enqueueOperation({
    target: 'fn_partir_cuenta_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_original_id: args.ventaOriginalId > 0 ? args.ventaOriginalId : null,
      p_venta_original_idempotency_uuid: args.ventaOriginalId < 0 ? '__pending_parent__' : null,
      p_item_ids: args.itemsToMove,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'venta', tempVentaId: tempVentaNuevaId },
  });
  void syncEngine.triggerPush();

  return { tempVentaNuevaId, queuedOpId };
}
