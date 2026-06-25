// cuponesService — descuentos/vouchers de Habitué. REUSA la tabla `cupones` que
// ya existe (la misma que valida y canjea la tienda online de COMANDA vía
// fn_validar_cupon). Un "voucher" = cupón con max_usos = 1.

import { db } from './supabase';

export type CanalCupon = 'tienda_online' | 'marketplace' | 'pos' | 'whatsapp' | 'menu_qr';

export interface Cupon {
  id: number;
  code: string;
  descripcion: string | null;
  tipo: 'porcentaje' | 'monto_fijo';
  valor: number;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  monto_min_compra: number | null;
  max_usos: number | null;
  max_usos_por_cliente: number | null;
  solo_primera_compra: boolean;
  activo: boolean;
  usos_actuales: number;
  canales_aplicables: CanalCupon[] | null;
  created_at: string;
}

const COLS = 'id, code, descripcion, tipo, valor, fecha_desde, fecha_hasta, monto_min_compra, max_usos, max_usos_por_cliente, solo_primera_compra, activo, usos_actuales, canales_aplicables, created_at';

export async function listCupones(): Promise<{ data: Cupon[]; error: string | null }> {
  const { data, error } = await db().from('cupones').select(COLS).is('deleted_at', null).order('created_at', { ascending: false });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Cupon[], error: null };
}

export interface CuponInput {
  code: string;
  descripcion?: string;
  tipo: 'porcentaje' | 'monto_fijo';
  valor: number;
  fechaHasta?: string;
  montoMinCompra?: number;
  maxUsos?: number;
  soloPrimeraCompra?: boolean;
  canales: CanalCupon[];
}

export async function crearCupon(tenantId: string, input: CuponInput): Promise<{ error: string | null }> {
  const { error } = await db().from('cupones').insert({
    tenant_id: tenantId,
    local_id: null,
    code: input.code.trim().toUpperCase(),
    descripcion: input.descripcion?.trim() || null,
    tipo: input.tipo,
    valor: input.valor,
    fecha_hasta: input.fechaHasta || null,
    monto_min_compra: input.montoMinCompra ?? null,
    max_usos: input.maxUsos ?? null,
    solo_primera_compra: !!input.soloPrimeraCompra,
    canales_aplicables: input.canales.length ? input.canales : null,
    activo: true,
  });
  return { error: error?.message ?? null };
}

export async function toggleCupon(id: number, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db().from('cupones').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function eliminarCupon(id: number): Promise<{ error: string | null }> {
  const { error } = await db().from('cupones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
