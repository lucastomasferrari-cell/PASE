import { db } from '../lib/supabase';
import type { Canal } from '../types/database';
import { translateError } from '../lib/errors';

export async function listCanales(tenantId: string | null, soloActivos = false): Promise<{ data: Canal[]; error: string | null }> {
  let q = db
    .from('canales')
    .select('*')
    .is('deleted_at', null)
    .order('grupo', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  if (soloActivos) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: data ?? [], error: null };
}

export type CanalDraft = Pick<
  Canal,
  | 'nombre' | 'slug' | 'emoji' | 'color' | 'modo_pos' | 'atado_madre'
  | 'ajuste_madre_pct' | 'comision_externa_pct' | 'redondeo_a' | 'activo' | 'grupo'
> & { tenant_id: string; local_id: number | null };

export async function createCanal(draft: CanalDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('canales').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateCanal(id: number, patch: Partial<CanalDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('canales').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function toggleCanalActivo(id: number, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db.from('canales').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}
