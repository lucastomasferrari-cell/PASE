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
): Promise<{ totalCobrado: number; error: string | null }> {
  if (!pagos.length) return { totalCobrado: 0, error: 'No hay pagos para registrar' };
  const { data, error } = await db.rpc('fn_cobrar_venta_comanda', {
    p_venta_id: ventaId,
    p_pagos: pagos,
    p_propina: propina,
    p_cobrado_por: cobradoPor,
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
): Promise<{ totalReembolsado: number; error: string | null }> {
  const { data, error } = await db.rpc('fn_refund_venta_comanda', {
    p_venta_id: ventaId, p_manager_id: managerId, p_motivo: motivo,
  });
  if (error) return { totalReembolsado: 0, error: error.message };
  return { totalReembolsado: Number(data ?? 0), error: null };
}
