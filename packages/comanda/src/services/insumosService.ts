import { db } from '../lib/supabase';
import type { Insumo, UnidadInsumo } from '../types/database';

// Service de insumos (F1.1b — UI editor recetas).
// Insumos viven por tenant + opcionalmente por local (local_id NULL = global).
// RLS y UNIQUE parcial ya creados en migration F1.1.

export interface ListInsumosOpts {
  localId?: number | null; // null/undefined = todos los del tenant (globales + de todos los locales accesibles)
  search?: string;
  onlyActivos?: boolean;
  limit?: number;
}

export async function listInsumos(
  opts: ListInsumosOpts = {},
): Promise<{ data: Insumo[]; error: string | null }> {
  let q = db
    .from('insumos')
    .select('*')
    .is('deleted_at', null)
    .order('nombre', { ascending: true })
    .limit(opts.limit ?? 200);

  if (opts.localId != null) {
    // Pedidos para un local específico: incluir el local + los globales (NULL).
    q = q.or(`local_id.eq.${opts.localId},local_id.is.null`);
  }
  if (opts.onlyActivos !== false) {
    q = q.eq('activo', true);
  }
  if (opts.search?.trim()) {
    q = q.ilike('nombre', `%${opts.search.trim()}%`);
  }

  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Insumo[], error: null };
}

export async function getInsumo(id: number): Promise<{ data: Insumo | null; error: string | null }> {
  const { data, error } = await db
    .from('insumos').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: data as Insumo | null, error: null };
}

export interface InsumoInput {
  nombre: string;
  unidad: UnidadInsumo;
  descripcion?: string | null;
  emoji?: string | null;
  foto_url?: string | null;
  costo_actual?: number | null;
  activo?: boolean;
  es_comprado?: boolean;
  local_id?: number | null;
}

export async function createInsumo(
  tenantId: string,
  input: InsumoInput,
): Promise<{ data: Insumo | null; error: string | null }> {
  // costo_actualizado_at se setea automático si se manda costo_actual.
  const payload: Record<string, unknown> = { tenant_id: tenantId, ...input };
  if (input.costo_actual != null) {
    payload.costo_actualizado_at = new Date().toISOString();
  }
  const { data, error } = await db
    .from('insumos').insert(payload).select('*').single();
  if (error) return { data: null, error: error.message };
  return { data: data as Insumo, error: null };
}

export async function updateInsumo(
  id: number,
  patch: Partial<InsumoInput>,
): Promise<{ data: Insumo | null; error: string | null }> {
  // Si actualiza costo_actual, setear costo_actualizado_at.
  const payload: Record<string, unknown> = { ...patch };
  if (patch.costo_actual !== undefined) {
    payload.costo_actualizado_at = new Date().toISOString();
  }
  const { data, error } = await db
    .from('insumos').update(payload).eq('id', id).select('*').single();
  if (error) return { data: null, error: error.message };
  return { data: data as Insumo, error: null };
}

export async function softDeleteInsumo(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('insumos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
