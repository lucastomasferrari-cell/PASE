import { db } from '../lib/supabase';
import type { Item, ItemEstado } from '../types/database';
import { translateError } from '../lib/errors';

export type ItemConGrupo = Item & {
  grupo: { id: number; nombre: string; emoji: string | null; color: string | null } | null;
};

export interface ItemsListFilter {
  search?: string;
  grupoId?: number | null;
  estado?: ItemEstado | 'todos';
  localId?: number | null;
  tenantId: string | null;
}

export async function listItems(filter: ItemsListFilter): Promise<{ data: ItemConGrupo[]; error: string | null }> {
  let q = db
    .from('items')
    .select(`
      id, tenant_id, local_id, created_at, updated_at, deleted_at,
      created_by, updated_by, nombre, descripcion, emoji, foto_url, codigo,
      grupo_id, orden, precio_madre, costo_actual, costo_actualizado_at,
      receta_version_id_vigente, tax_rate_id, estacion, estado,
      agotado_motivo, agotado_por, agotado_at, agotado_hasta, es_combo,
      visible_pos, visible_qr, visible_tienda, es_open_item,
      grupo:item_grupos(id, nombre, emoji, color)
    `)
    .is('deleted_at', null)
    .order('orden', { ascending: true })
    .order('id', { ascending: true })
    .limit(500);

  if (filter.tenantId) q = q.eq('tenant_id', filter.tenantId);
  if (filter.grupoId) q = q.eq('grupo_id', filter.grupoId);
  if (filter.estado && filter.estado !== 'todos') q = q.eq('estado', filter.estado);
  if (filter.search && filter.search.trim()) {
    q = q.ilike('nombre', `%${filter.search.trim()}%`);
  }

  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as unknown as ItemConGrupo[], error: null };
}

export type ItemDraft = Pick<
  Item,
  'nombre' | 'descripcion' | 'emoji' | 'codigo' | 'grupo_id' | 'precio_madre' |
  'tax_rate_id' | 'estacion' | 'visible_pos' | 'visible_qr' | 'visible_tienda' | 'es_combo'
> & { tenant_id: string; local_id: number | null; tiempo_prep_min?: number | null };

export async function createItem(draft: ItemDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('items').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateItem(
  id: number,
  patch: Partial<ItemDraft>,
): Promise<{ error: string | null }> {
  const { error } = await db.from('items').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteItem(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function marcarAgotado(
  itemId: number,
  motivo: string,
  hasta: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_agotado_comanda', {
    p_item_id: itemId,
    p_motivo: motivo,
    p_hasta: hasta,
  });
  return { error: error?.message ?? null };
}

export async function marcarDisponible(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_disponible_comanda', { p_item_id: itemId });
  return { error: error?.message ?? null };
}
