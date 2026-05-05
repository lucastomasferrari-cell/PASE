import { db } from '../lib/supabase';
import type { ModifierGroup, Modifier, ItemModifierGroup } from '../types/database';

// ─── ModifierGroups ────────────────────────────────────────────────────────

export async function listModifierGroups(tenantId: string | null): Promise<{ data: ModifierGroup[]; error: string | null }> {
  let q = db.from('modifier_groups').select('*').is('deleted_at', null).order('id', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: data ?? [], error: null };
}

export type ModifierGroupDraft = Pick<
  ModifierGroup,
  'nombre' | 'descripcion' | 'requerido' | 'min_seleccion' | 'max_seleccion' | 'tipo'
> & { tenant_id: string; local_id: number | null };

export async function createModifierGroup(draft: ModifierGroupDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('modifier_groups').insert(draft).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

export async function updateModifierGroup(id: number, patch: Partial<ModifierGroupDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('modifier_groups').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteModifierGroup(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('modifier_groups').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// ─── Modifiers (opciones dentro de un group) ───────────────────────────────

export async function listModifiers(groupId: number): Promise<{ data: Modifier[]; error: string | null }> {
  const { data, error } = await db
    .from('modifiers')
    .select('*')
    .eq('modifier_group_id', groupId)
    .is('deleted_at', null)
    .order('orden', { ascending: true })
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: data ?? [], error: null };
}

export type ModifierDraft = Pick<Modifier, 'nombre' | 'precio_extra' | 'orden' | 'activo'> & {
  modifier_group_id: number;
  tenant_id: string;
};

export async function createModifier(draft: ModifierDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('modifiers').insert(draft).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

export async function updateModifier(id: number, patch: Partial<ModifierDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('modifiers').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteModifier(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('modifiers').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// ─── Asignación item ↔ modifier_group ──────────────────────────────────────

export async function listAsignacionesPorItem(itemId: number): Promise<{ data: ItemModifierGroup[]; error: string | null }> {
  const { data, error } = await db
    .from('item_modifier_groups')
    .select('*')
    .eq('item_id', itemId)
    .order('orden', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: data ?? [], error: null };
}

export async function asignarModifierGroup(
  itemId: number,
  modifierGroupId: number,
  tenantId: string,
  orden = 0,
): Promise<{ error: string | null }> {
  const { error } = await db.from('item_modifier_groups').insert({
    item_id: itemId,
    modifier_group_id: modifierGroupId,
    tenant_id: tenantId,
    orden,
  });
  return { error: error?.message ?? null };
}

export async function desasignarModifierGroup(itemId: number, modifierGroupId: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('item_modifier_groups')
    .delete()
    .eq('item_id', itemId)
    .eq('modifier_group_id', modifierGroupId);
  return { error: error?.message ?? null };
}
