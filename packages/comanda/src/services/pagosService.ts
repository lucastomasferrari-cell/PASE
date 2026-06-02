import { db } from '../lib/supabase';
import type { VentaPosPago } from '../types/database';
import { translateError } from '../lib/errors';

export interface PagoInput {
  metodo: string;
  monto: number;
  idempotency_key: string;
  vuelto?: number | null;
  propina_incluida?: number;
}

export function newIdempotencyKey(): string {
  // Browsers modernos exponen crypto.randomUUID(); fallback compatible.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'pago-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

export async function cobrar(
  ventaId: number,
  pagos: PagoInput[],
  propina: number,
  cobradoPor: string | null,
  idempotencyKey?: string,
): Promise<{ totalCobrado: number; error: string | null }> {
  if (!pagos.length) return { totalCobrado: 0, error: 'No hay pagos para registrar' };

  // Sprint offline-first cierre (2026-06-02): si el flag está ON, encolar
  // el cobro localmente. La venta se marca cobrada inmediato en idb, el
  // sync push lo procesa cuando hay internet usando fn_cobrar_venta_comanda_offline
  // (que resuelve venta_id desde idempotency_uuid si la venta es local-only).
  // Resuelve el bug "La venta no existe" al cobrar venta offline.
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { cobrarVentaOffline } = await import('./offline/pagosOfflineService');
    const { ventasRepo } = await import('@/lib/db/repositories/ventasRepo');
    const venta = await ventasRepo.getById(ventaId);
    if (!venta) return { totalCobrado: 0, error: 'VENTA_NO_ENCONTRADA' };
    try {
      const r = await cobrarVentaOffline({
        ventaId,
        pagos: pagos.map((p) => ({
          metodo: p.metodo,
          monto: p.monto,
          vuelto: p.vuelto ?? 0,
          propina_incluida: p.propina_incluida ?? 0,
        })),
        propina,
        cobradoPor,
        tenantId: venta.tenant_id,
        localId: venta.local_id,
      });
      return { totalCobrado: r.totalCobrado, error: null };
    } catch (err) {
      return {
        totalCobrado: 0,
        error: err instanceof Error ? err.message : 'Error cobrando offline',
      };
    }
  }

  // Flujo legacy online-only
  const { data, error } = await db.rpc('fn_cobrar_venta_comanda', {
    p_venta_id: ventaId,
    p_pagos: pagos,
    p_propina: propina,
    p_cobrado_por: cobradoPor,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { totalCobrado: 0, error: translateError(error) };
  return { totalCobrado: Number(data ?? 0), error: null };
}

export async function listPagosVenta(ventaId: number): Promise<{ data: VentaPosPago[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- filtra por venta_id (FK a ventas_pos) que ya implica local específico; RLS server-side cubre tenant scope.
  const { data, error } = await db
    .from('ventas_pos_pagos')
    .select('*')
    .eq('venta_id', ventaId)
    .is('deleted_at', null)
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as VentaPosPago[], error: null };
}

export async function refundVenta(
  ventaId: number, managerId: string, motivo: string,
  idempotencyKey?: string,
): Promise<{ totalReembolsado: number; error: string | null }> {
  const { data, error } = await db.rpc('fn_refund_venta_comanda', {
    p_venta_id: ventaId,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { totalReembolsado: 0, error: translateError(error) };
  return { totalReembolsado: Number(data ?? 0), error: null };
}

// ─── Multi-pago (Sprint 4) ────────────────────────────────────────────────
// Pago parcial idempotente. Cuando la suma cubra el total, fn_agregar_pago
// marca la venta cobrada automáticamente y libera mesa.

export interface AgregarPagoArgs {
  ventaId: number;
  metodo: string;
  monto: number;
  idempotencyKey: string;
  cobradoPor?: string | null;
  vuelto?: number | null;
  propinaIncluida?: number;
  /** Cuotas (3/6/12 típico AR). Solo aplica a métodos de crédito —
   * la RPC ignora el valor si el método no es 'credito'/'tc'. */
  cuotas?: number | null;
}

export async function agregarPago(args: AgregarPagoArgs): Promise<{ pagoId: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_agregar_pago_venta_comanda', {
    p_venta_id: args.ventaId,
    p_metodo: args.metodo,
    p_monto: args.monto,
    p_idempotency_key: args.idempotencyKey,
    p_cobrado_por: args.cobradoPor ?? null,
    p_vuelto: args.vuelto ?? null,
    p_propina_incluida: args.propinaIncluida ?? 0,
    p_cuotas: args.cuotas ?? null,
  });
  if (error) return { pagoId: null, error: translateError(error) };
  return { pagoId: data as number, error: null };
}
