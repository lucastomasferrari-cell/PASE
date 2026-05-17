// pagosOfflineService — cobrar venta offline.
//
// Cobrar es la operación más crítica del POS (mueve dinero, no se puede
// duplicar). El patrón ofreciendo idempotency_uuid garantiza que un retry
// del push no genere doble cobro.
//
// Flow offline:
//   1. Cajero confirma pagos (puede ser 1 método o split: efectivo + tarjeta).
//   2. pagosOfflineService:
//      a. Crea ventas_pos_pagos rows locales (uno por método) con tempIds.
//      b. Update venta local: estado='cobrada', cobrada_at=now, pagada=true.
//      c. Encola op `fn_cobrar_venta_comanda` con reconcile hint.
//   3. UI navega a confirmación inmediata (cajero ya cobró).
//   4. Cuando vuelve internet, push procesa la RPC `_offline`:
//      - Server resuelve venta_id si era tempVentaId.
//      - Crea ventas_pos_pagos reales en server.
//      - Marca venta como cobrada server-side.
//      - Triggers de caja + saldos disparan automático.
//      - Retorna BIGINT del total cobrado.

import { ventasRepo, ventasPagosRepo } from '@/lib/db/repositories/ventasRepo';
import { enqueueOperation } from '@/lib/sync/operations';
import { syncEngine } from '@/lib/sync/syncEngine';
import type { LocalVentaPago } from '@/lib/db/schema';

let _tempIdCounter = -2_000_000_000;
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

export interface PagoInput {
  metodo: string;          // 'efectivo' | 'tarjeta-debito' | 'qr-mp' | ...
  monto: number;
  vuelto?: number | null;
  propina_incluida?: number;
}

export interface CobrarVentaArgs {
  ventaId: number;                    // tempId negativo o BIGINT real
  pagos: PagoInput[];
  propina?: number;
  cobradoPor?: string | null;
  tenantId: string;
  localId: number;
}

export interface CobrarVentaResult {
  totalCobrado: number;
  idempotencyUuid: string;
  queuedOpId: string;
  tempPagoIds: number[];
}

export async function cobrarVentaOffline(args: CobrarVentaArgs): Promise<CobrarVentaResult> {
  const idempotencyUuid = genUUID();
  const now = new Date().toISOString();

  // 1. Crear ventas_pos_pagos rows locales (uno por método)
  const tempPagoIds: number[] = [];
  for (const p of args.pagos) {
    const tempId = nextTempId();
    tempPagoIds.push(tempId);
    const pago: LocalVentaPago = {
      id: tempId,
      tenant_id: args.tenantId,
      local_id: args.localId,
      venta_id: args.ventaId,
      metodo: p.metodo,
      monto: p.monto,
      idempotency_key: genUUID(),  // por-pago (server-side dedup)
      vuelto: p.vuelto ?? 0,
      propina_incluida: p.propina_incluida ?? 0,
      cobrado_por: args.cobradoPor ?? null,
      created_at: now,
    } as unknown as LocalVentaPago;
    await ventasPagosRepo.put(pago);
  }

  // 2. Update venta local — estado cobrada, pagada=true
  const venta = await ventasRepo.getById(args.ventaId);
  if (venta) {
    venta.estado = 'cobrada';
    (venta as unknown as { cobrada_at: string | null }).cobrada_at = now;
    (venta as unknown as { pagada: boolean }).pagada = true;
    venta.propina = args.propina ?? 0;
    const totalConPropina = Number(venta.subtotal) - Number(venta.descuento_total ?? 0) + (args.propina ?? 0);
    venta.total = totalConPropina;
    venta.updated_at = now;
    await ventasRepo.put(venta);
  }

  // 3. Encola RPC `fn_cobrar_venta_comanda` (variante _offline en server)
  const queuedOpId = await enqueueOperation({
    target: 'fn_cobrar_venta_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: args.ventaId > 0 ? args.ventaId : null,
      p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
      p_pagos: args.pagos.map((p) => ({
        metodo: p.metodo,
        monto: p.monto,
        vuelto: p.vuelto ?? 0,
        propina_incluida: p.propina_incluida ?? 0,
      })),
      p_propina: args.propina ?? 0,
      p_cobrado_por: args.cobradoPor ?? null,
      p_idempotency_uuid: idempotencyUuid,
    },
    // Las pagos rows también necesitan reconciliación pero la RPC retorna
    // el total cobrado (NUMERIC), no los ids de los pagos. Por eso reconcile=
    // 'none' acá — el pull incremental va a traer los pagos reales con sus
    // BIGINTs cuando llegue. Los temp rows se quedan en local hasta entonces
    // (con _local_dirty=true → indicador visual).
    reconcile: { kind: 'none' },
  });

  void syncEngine.triggerPush();

  return {
    totalCobrado: Number(venta?.total ?? 0),
    idempotencyUuid,
    queuedOpId,
    tempPagoIds,
  };
}
