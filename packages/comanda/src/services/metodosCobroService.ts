import { db } from '../lib/supabase';
import type { MetodoCobro } from '../types/database';
import { translateError } from '../lib/errors';

export async function listMetodos(tenantId: string): Promise<{ data: MetodoCobro[]; error: string | null }> {
  const { data, error } = await db
    .from('metodos_cobro')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('orden', { ascending: true })
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MetodoCobro[], error: null };
}

export type MetodoDraft = Pick<
  MetodoCobro,
  'nombre' | 'slug' | 'emoji' | 'pide_vuelto' | 'activo' | 'orden'
> & { tenant_id: string; local_id: number | null };

export async function createMetodo(draft: MetodoDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('metodos_cobro').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateMetodo(id: number, patch: Partial<MetodoDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('metodos_cobro').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteMetodo(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('metodos_cobro').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function toggleActivo(id: number, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db.from('metodos_cobro').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function setOrden(id: number, orden: number): Promise<{ error: string | null }> {
  const { error } = await db.from('metodos_cobro').update({ orden }).eq('id', id);
  return { error: error?.message ?? null };
}
