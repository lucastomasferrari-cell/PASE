import { db } from '../lib/supabase';
import type { Mesa, EstadoMesa, FormaMesa } from '../types/database';

export async function listMesas(localId: number): Promise<{ data: Mesa[]; error: string | null }> {
  const { data, error } = await db
    .from('mesas')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('zona', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Mesa[], error: null };
}

// Mesa con info adicional para el grid (venta abierta + total + tiempo)
export interface MesaConVenta extends Mesa {
  venta_abierta_id: number | null;
  venta_total: number;
  venta_abierta_at: string | null;
}

export async function listMesasConVentas(localId: number): Promise<{ data: MesaConVenta[]; error: string | null }> {
  // 2 queries en paralelo: mesas + ventas abiertas del local
  const [mesasRes, ventasRes] = await Promise.all([
    db.from('mesas').select('*').eq('local_id', localId).is('deleted_at', null)
      .order('zona', { ascending: true, nullsFirst: false }).order('id', { ascending: true }),
    db.from('ventas_pos').select('id, mesa_id, total, abierta_at, estado')
      .eq('local_id', localId).in('estado', ['abierta', 'enviada', 'lista', 'entregada'])
      .is('deleted_at', null),
  ]);
  if (mesasRes.error) return { data: [], error: mesasRes.error.message };
  if (ventasRes.error) return { data: [], error: ventasRes.error.message };
  const ventasByMesa = new Map<number, { id: number; total: number; abierta_at: string }>();
  for (const v of ventasRes.data ?? []) {
    if (v.mesa_id !== null && v.mesa_id !== undefined) {
      ventasByMesa.set(v.mesa_id as number, {
        id: v.id as number,
        total: Number(v.total ?? 0),
        abierta_at: v.abierta_at as string,
      });
    }
  }
  const data: MesaConVenta[] = (mesasRes.data ?? []).map((m) => {
    const v = ventasByMesa.get(m.id as number);
    return {
      ...(m as Mesa),
      venta_abierta_id: v?.id ?? null,
      venta_total: v?.total ?? 0,
      venta_abierta_at: v?.abierta_at ?? null,
    };
  });
  return { data, error: null };
}

export interface MesaDraft {
  numero: string;
  zona: string | null;
  capacidad: number | null;
  forma: FormaMesa;
  tenant_id: string;
  local_id: number;
}

export async function createMesa(draft: MesaDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('mesas').insert(draft).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

export async function updateMesa(id: number, patch: Partial<MesaDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('mesas').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function setMesaEstado(id: number, estado: EstadoMesa): Promise<{ error: string | null }> {
  const { error } = await db.from('mesas').update({ estado }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteMesa(id: number): Promise<{ error: string | null }> {
  // Validar no tiene ventas históricas
  const { count } = await db.from('ventas_pos')
    .select('id', { count: 'exact', head: true }).eq('mesa_id', id);
  if ((count ?? 0) > 0) return { error: 'No se puede borrar: la mesa tiene ventas asociadas.' };
  const { error } = await db.from('mesas').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
