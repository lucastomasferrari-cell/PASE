import { db } from '../lib/supabase';
import type { ComboComponente, Item } from '../types/database';
import { translateError } from '../lib/errors';

// Servicios de combos. El modelo ya existe en DB:
//   items.es_combo BOOLEAN
//   combo_componentes (combo_id, slot_nombre, slot_orden, min/max, item_elegible_id, precio_extra)
//
// Un combo es un item con es_combo=true. Sus "slots" agrupan opciones que el
// cliente elige. Ej: combo Hamburguesa+Bebida+Postre tiene 3 slots, cada
// uno con N items elegibles.

export async function listComboComponentes(comboId: number): Promise<{ data: ComboComponente[]; error: string | null }> {
  const { data, error } = await db
    .from('combo_componentes')
    .select('*')
    .eq('combo_id', comboId)
    .is('deleted_at', null)
    .order('slot_orden', { ascending: true })
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: data ?? [], error: null };
}

export type ComboComponenteDraft = Pick<
  ComboComponente,
  'combo_id' | 'slot_nombre' | 'slot_orden' | 'min_seleccion' | 'max_seleccion' | 'item_elegible_id' | 'precio_extra'
> & { tenant_id: string };

export async function addComponente(draft: ComboComponenteDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('combo_componentes').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function softDeleteComponente(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('combo_componentes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// ─── Sprint Combos: helpers de alto nivel ─────────────────────────────────

// Lista todos los items con es_combo=true del tenant. Sirve para la pantalla
// CombosLista (admin).
export async function listCombos(tenantId: string): Promise<{ data: Item[]; error: string | null }> {
  const { data, error } = await db
    .from('items')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('es_combo', true)
    .is('deleted_at', null)
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Item[], error: null };
}

export interface ComboSlot {
  nombre: string;
  orden: number;
  min: number;
  max: number;
  opciones: Array<{
    componente_id: number;
    item_id: number;
    nombre: string;
    emoji: string | null;
    precio_madre: number;
    precio_extra: number;
  }>;
}

export interface ComboConSlots {
  combo: Item;
  slots: ComboSlot[];
}

// Carga el combo + sus componentes hidratados con info del item elegible.
// Agrupa por slot_nombre para la UI (1 entrada de slot en la lista, N opciones).
export async function getComboConSlots(comboId: number): Promise<{ data: ComboConSlots | null; error: string | null }> {
  const [comboRes, compRes] = await Promise.all([
    db.from('items').select('*').eq('id', comboId).single(),
    db.from('combo_componentes')
      .select(`
        id, combo_id, slot_nombre, slot_orden, min_seleccion, max_seleccion, item_elegible_id, precio_extra,
        item_elegible:items!combo_componentes_item_elegible_id_fkey(id, nombre, emoji, precio_madre)
      `)
      .eq('combo_id', comboId)
      .is('deleted_at', null)
      .order('slot_orden', { ascending: true }),
  ]);
  if (comboRes.error || !comboRes.data) return { data: null, error: comboRes.error?.message ?? 'Combo no encontrado' };
  if (compRes.error) return { data: null, error: compRes.error.message };

  type Row = ComboComponente & {
    item_elegible?: { id: number; nombre: string; emoji: string | null; precio_madre: number } | null;
  };
  const componentes = (compRes.data ?? []) as unknown as Row[];

  const slotsMap = new Map<string, ComboSlot>();
  for (const c of componentes) {
    let slot = slotsMap.get(c.slot_nombre);
    if (!slot) {
      slot = { nombre: c.slot_nombre, orden: c.slot_orden, min: c.min_seleccion, max: c.max_seleccion, opciones: [] };
      slotsMap.set(c.slot_nombre, slot);
    }
    const it = c.item_elegible;
    if (it) {
      slot.opciones.push({
        componente_id: c.id,
        item_id: it.id,
        nombre: it.nombre,
        emoji: it.emoji,
        precio_madre: Number(it.precio_madre),
        precio_extra: Number(c.precio_extra),
      });
    }
  }
  return {
    data: {
      combo: comboRes.data as Item,
      slots: Array.from(slotsMap.values()).sort((a, b) => a.orden - b.orden),
    },
    error: null,
  };
}

export interface ComponenteFlat {
  slot_nombre: string;
  slot_orden: number;
  min_seleccion: number;
  max_seleccion: number;
  item_elegible_id: number;
  precio_extra: number;
}

// Reemplaza TODA la composición del combo: soft-delete previa + insert nuevos.
// Atómico desde el cliente (no es transacción DB — si falla a mitad, dejá
// inconsistencia. Es aceptable porque retry idempotente: el siguiente save
// vuelve a borrar todo e inserta correcto).
export async function setComboComponentes(
  tenantId: string,
  comboId: number,
  componentes: ComponenteFlat[],
): Promise<{ error: string | null }> {
  const { error: delErr } = await db
    .from('combo_componentes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('combo_id', comboId)
    .is('deleted_at', null);
  if (delErr) return { error: delErr.message };

  if (componentes.length === 0) return { error: null };

  const rows = componentes.map((c) => ({
    tenant_id: tenantId,
    combo_id: comboId,
    slot_nombre: c.slot_nombre,
    slot_orden: c.slot_orden,
    min_seleccion: c.min_seleccion,
    max_seleccion: c.max_seleccion,
    item_elegible_id: c.item_elegible_id,
    precio_extra: c.precio_extra,
  }));
  const { error: insErr } = await db.from('combo_componentes').insert(rows);
  if (insErr) return { error: insErr.message };
  return { error: null };
}
