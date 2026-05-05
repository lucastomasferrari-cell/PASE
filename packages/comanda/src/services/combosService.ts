import { db } from '../lib/supabase';
import type { ComboComponente } from '../types/database';

export async function listComboComponentes(comboId: number): Promise<{ data: ComboComponente[]; error: string | null }> {
  const { data, error } = await db
    .from('combo_componentes')
    .select('*')
    .eq('combo_id', comboId)
    .is('deleted_at', null)
    .order('slot_orden', { ascending: true })
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: data ?? [], error: null };
}

export type ComboComponenteDraft = Pick<
  ComboComponente,
  'combo_id' | 'slot_nombre' | 'slot_orden' | 'min_seleccion' | 'max_seleccion' | 'item_elegible_id' | 'precio_extra'
> & { tenant_id: string };

export async function addComponente(draft: ComboComponenteDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('combo_componentes').insert(draft).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

export async function softDeleteComponente(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('combo_componentes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
