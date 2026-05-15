import { db } from '../lib/supabase';
import type { ItemGrupo } from '../types/database';
import { translateError } from '../lib/errors';

export async function listGrupos(tenantId: string | null): Promise<{ data: ItemGrupo[]; error: string | null }> {
  let q = db
    .from('item_grupos')
    .select('*')
    .is('deleted_at', null)
    .order('orden', { ascending: true })
    .order('id', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: data ?? [], error: null };
}

export type GrupoDraft = Pick<
  ItemGrupo,
  'nombre' | 'color' | 'color_ramp' | 'emoji' | 'orden' | 'tax_rate_id' | 'estacion_default'
> & {
  tenant_id: string;
  local_id: number | null;
};

export async function createGrupo(draft: GrupoDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('item_grupos').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateGrupo(id: number, patch: Partial<GrupoDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('item_grupos').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteGrupo(id: number): Promise<{ error: string | null }> {
  // Validar que no tenga items asignados
  const { count, error: countErr } = await db
    .from('items')
    .select('id', { count: 'exact', head: true })
    .eq('grupo_id', id)
    .is('deleted_at', null);
  if (countErr) return { error: countErr.message };
  if ((count ?? 0) > 0) {
    return { error: `No se puede borrar: el grupo tiene ${count} item(s) asignado(s).` };
  }
  const { error } = await db.from('item_grupos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function countItemsPorGrupo(tenantId: string | null): Promise<Record<number, number>> {
  let q = db.from('items').select('grupo_id').is('deleted_at', null).not('grupo_id', 'is', null);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data } = await q;
  const out: Record<number, number> = {};
  for (const row of data ?? []) {
    const gid = (row as { grupo_id: number | null }).grupo_id;
    if (gid !== null) out[gid] = (out[gid] ?? 0) + 1;
  }
  return out;
}
