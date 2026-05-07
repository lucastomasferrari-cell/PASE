import { db } from '../lib/supabase';
import type { VentaPosPago } from '../types/database';

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
  const { data, error } = await db.rpc('fn_cobrar_venta_comanda', {
    p_venta_id: ventaId,
    p_pagos: pagos,
    p_propina: propina,
    p_cobrado_por: cobradoPor,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { totalCobrado: 0, error: error.message };
  return { totalCobrado: Number(data ?? 0), error: null };
}

export async function listPagosVenta(ventaId: number): Promise<{ data: VentaPosPago[]; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos_pagos')
    .select('*')
    .eq('venta_id', ventaId)
    .is('deleted_at', null)
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
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
  if (error) return { totalReembolsado: 0, error: error.message };
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
  });
  if (error) return { pagoId: null, error: error.message };
  return { pagoId: data as number, error: null };
}
