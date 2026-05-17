// overridesOfflineService — operaciones que requieren manager override
// (anular, descuento, cortesía, cambio precio) en modo offline.
//
// Patrón: las operaciones de override en la DB tienen su tabla aparte
// (ventas_pos_overrides) con auditoría completa (quién autorizó, motivo,
// timestamp). En offline registramos local + encolamos.
//
// IMPORTANTE: el manager_id local DEBE ser el real (UUID del empleado con
// rol manager que autorizó). El cajero ingresa el PIN del manager → se
// resuelve a su UUID localmente desde el repo de empleados (que ya está
// cacheado en pullInitial). Si no está cacheado (mánager nuevo no
// sincronizado todavía), se pide que reintente cuando vuelva internet.

import { ventasItemsRepo, ventasRepo } from '@/lib/db/repositories/ventasRepo';
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

// ─── Anular item ────────────────────────────────────────────────────────────

export interface AnularItemArgs {
  itemId: number;          // tempId o BIGINT real
  managerId: string;
  motivo: string;
}

export async function anularItemOffline(args: AnularItemArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  // Update local: marcar item como anulado
  const item = await ventasItemsRepo.getById(args.itemId);
  if (item) {
    item.estado = 'anulado';
    (item as unknown as { anulado_at: string }).anulado_at = now;
    (item as unknown as { anulado_motivo: string }).anulado_motivo = args.motivo;
    item.updated_at = now;
    await ventasItemsRepo.put(item);
    // Recalcular total venta local (resta el subtotal del item anulado)
    const venta = await ventasRepo.getById(item.venta_id);
    if (venta) {
      venta.subtotal = Math.max(0, Number(venta.subtotal) - Number(item.subtotal));
      venta.total = Math.max(0, Number(venta.total) - Number(item.subtotal));
      venta.updated_at = now;
      await ventasRepo.put(venta);
    }
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_anular_item_comanda',
    op_type: 'rpc',
    payload: {
      p_item_id: args.itemId > 0 ? args.itemId : null,
      p_item_idempotency_uuid: args.itemId < 0 ? '__pending_parent__' : null,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Cortesía (item gratis con auditoría) ───────────────────────────────────

export interface CortesiaItemArgs {
  itemId: number;
  managerId: string;
  motivo: string;
}

export async function cortesiaItemOffline(args: CortesiaItemArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  const item = await ventasItemsRepo.getById(args.itemId);
  if (item) {
    const subOriginal = Number(item.subtotal);
    (item as unknown as { es_cortesia: boolean }).es_cortesia = true;
    (item as unknown as { precio_unitario_original: number }).precio_unitario_original = Number(item.precio_unitario);
    item.precio_unitario = 0;
    item.subtotal = 0;
    item.updated_at = now;
    await ventasItemsRepo.put(item);
    const venta = await ventasRepo.getById(item.venta_id);
    if (venta) {
      venta.subtotal = Math.max(0, Number(venta.subtotal) - subOriginal);
      venta.total = Math.max(0, Number(venta.total) - subOriginal);
      venta.updated_at = now;
      await ventasRepo.put(venta);
    }
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_cortesia_item_comanda',
    op_type: 'rpc',
    payload: {
      p_item_id: args.itemId > 0 ? args.itemId : null,
      p_item_idempotency_uuid: args.itemId < 0 ? '__pending_parent__' : null,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Modificar precio puntual de un item ────────────────────────────────────

export interface ModificarPrecioItemArgs {
  itemId: number;
  precioNuevo: number;
  managerId: string;
  motivo: string;
}

export async function modificarPrecioItemOffline(args: ModificarPrecioItemArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  const item = await ventasItemsRepo.getById(args.itemId);
  if (item) {
    const subOriginal = Number(item.subtotal);
    if ((item as unknown as { precio_unitario_original?: number }).precio_unitario_original == null) {
      (item as unknown as { precio_unitario_original: number }).precio_unitario_original = Number(item.precio_unitario);
    }
    item.precio_unitario = args.precioNuevo;
    const subNuevo = Number(item.cantidad) * args.precioNuevo;
    item.subtotal = subNuevo;
    item.updated_at = now;
    await ventasItemsRepo.put(item);
    const venta = await ventasRepo.getById(item.venta_id);
    if (venta) {
      venta.subtotal = Math.max(0, Number(venta.subtotal) - subOriginal + subNuevo);
      venta.total = Math.max(0, Number(venta.total) - subOriginal + subNuevo);
      venta.updated_at = now;
      await ventasRepo.put(venta);
    }
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_modificar_precio_item_comanda',
    op_type: 'rpc',
    payload: {
      p_item_id: args.itemId > 0 ? args.itemId : null,
      p_item_idempotency_uuid: args.itemId < 0 ? '__pending_parent__' : null,
      p_precio_nuevo: args.precioNuevo,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Aplicar descuento global a la venta ────────────────────────────────────

export interface DescuentoVentaArgs {
  ventaId: number;
  monto: number;
  motivo: string;
  managerId: string | null;
}

export async function aplicarDescuentoOffline(args: DescuentoVentaArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  const venta = await ventasRepo.getById(args.ventaId);
  if (venta) {
    venta.descuento_total = (Number(venta.descuento_total ?? 0)) + args.monto;
    venta.total = Math.max(0, Number(venta.total) - args.monto);
    venta.updated_at = now;
    await ventasRepo.put(venta);
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_aplicar_descuento_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: args.ventaId > 0 ? args.ventaId : null,
      p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
      p_monto: args.monto,
      p_motivo: args.motivo,
      p_manager_id: args.managerId,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}

// ─── Anular venta entera ────────────────────────────────────────────────────

export interface AnularVentaArgs {
  ventaId: number;
  managerId: string;
  motivo: string;
}

export async function anularVentaOffline(args: AnularVentaArgs): Promise<{ queuedOpId: string }> {
  const now = new Date().toISOString();
  const venta = await ventasRepo.getById(args.ventaId);
  if (venta) {
    venta.estado = 'anulada';
    (venta as unknown as { anulada_at: string }).anulada_at = now;
    venta.updated_at = now;
    await ventasRepo.put(venta);
  }
  const queuedOpId = await enqueueOperation({
    target: 'fn_anular_venta_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: args.ventaId > 0 ? args.ventaId : null,
      p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
      p_manager_id: args.managerId,
      p_motivo: args.motivo,
      p_idempotency_uuid: genUUID(),
    },
    reconcile: { kind: 'none' },
  });
  void syncEngine.triggerPush();
  return { queuedOpId };
}
