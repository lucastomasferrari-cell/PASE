import { db } from '../lib/supabase';
import type { Receta, RecetaInsumo, Insumo, Item } from '../types/database';
import { translateError } from '../lib/errors';

// Service de recetas + receta_insumos (F1.1b — UI editor recetas).
//
// Patrón: cada item del catálogo puede tener UNA receta viva activa. Cuando
// se edita la receta (cambiar rendimiento o composición de insumos), se
// reemplaza la activa en una operación atómica.
//
// Para snapshot inmutable al momento de venta, se llama fn_snapshot_receta_a_version
// (definida en F1.1 migration) desde fn_cobrar_venta_comanda (F1.1c — pendiente).

// ─── Lectura ────────────────────────────────────────────────────────────────

export interface RecetaConInsumos extends Receta {
  insumos: Array<RecetaInsumo & { insumo: Pick<Insumo, 'id' | 'nombre' | 'unidad' | 'emoji' | 'costo_actual'> }>;
}

// Recetas listables — uso típico: pantalla "lista de items con sus recetas".
// Devuelve los items + receta_id_vigente joinedo.
export interface ItemConReceta {
  id: number;
  nombre: string;
  emoji: string | null;
  precio_madre: number;
  costo_actual: number | null;
  estado: string;
  receta_id_vigente: number | null;
  receta: Receta | null;
}

export async function listItemsConReceta(
  tenantId: string,
): Promise<{ data: ItemConReceta[]; error: string | null }> {
  const { data, error } = await db
    .from('items')
    .select('id, nombre, emoji, precio_madre, costo_actual, estado, receta_id_vigente, receta:recetas!items_receta_id_vigente_fkey(id, item_id, nombre, rendimiento, activa, deleted_at)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  type Row = Omit<Item, 'tenant_id' | 'local_id' | 'created_at' | 'updated_at' | 'deleted_at' | 'created_by' | 'updated_by' | 'descripcion' | 'foto_url' | 'codigo' | 'grupo_id' | 'orden' | 'costo_actualizado_at' | 'receta_version_id_vigente' | 'tax_rate_id' | 'estacion' | 'agotado_motivo' | 'agotado_por' | 'agotado_at' | 'agotado_hasta' | 'es_combo' | 'visible_pos' | 'visible_qr' | 'visible_tienda' | 'es_open_item'> & {
    receta_id_vigente: number | null;
    receta: Receta | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  return { data: rows.map((r) => ({
    id: r.id, nombre: r.nombre, emoji: r.emoji, precio_madre: Number(r.precio_madre),
    costo_actual: r.costo_actual != null ? Number(r.costo_actual) : null,
    estado: r.estado,
    receta_id_vigente: r.receta_id_vigente,
    receta: r.receta,
  })), error: null };
}

export async function getRecetaConInsumos(
  recetaId: number,
): Promise<{ data: RecetaConInsumos | null; error: string | null }> {
  const { data, error } = await db
    .from('recetas')
    .select('*, insumos:receta_insumos(*, insumo:insumos(id, nombre, unidad, emoji, costo_actual))')
    .eq('id', recetaId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { data: null, error: translateError(error) };
  if (!data) return { data: null, error: null };
  const r = data as unknown as RecetaConInsumos;
  // Filtrar receta_insumos soft-deleted client-side.
  return {
    data: { ...r, insumos: (r.insumos ?? []).filter((ri) => ri.deleted_at === null) },
    error: null,
  };
}

// Conveniencia: dada un item, devuelve su receta viva activa (con insumos).
export async function getRecetaPorItem(
  itemId: number,
): Promise<{ data: RecetaConInsumos | null; error: string | null }> {
  const { data: recetaRow, error: recErr } = await db
    .from('recetas')
    .select('id')
    .eq('item_id', itemId)
    .eq('activa', true)
    .is('deleted_at', null)
    .order('local_id', { ascending: false, nullsFirst: false }) // prefiere local sobre global
    .limit(1)
    .maybeSingle();
  if (recErr) return { data: null, error: recErr.message };
  if (!recetaRow) return { data: null, error: null };
  return getRecetaConInsumos((recetaRow as { id: number }).id);
}

// ─── Escritura — guardar receta atómica ─────────────────────────────────────
// Crea/actualiza la receta viva activa del item, junto con sus receta_insumos.
// "Atómico" client-side: hacemos el upsert + reemplazo de insumos en orden;
// si falla en el medio, la siguiente reload mostrará el estado real. Para
// atomicity full, en el futuro se mueve a RPC.

export interface RecetaInsumoInput {
  insumo_id: number;
  cantidad: number;
  merma_pct?: number;
  notas?: string | null;
  orden?: number;
}

export interface UpsertRecetaInput {
  itemId: number;
  tenantId: string;
  localId: number | null;
  nombre: string;
  rendimiento: number;
  notas?: string | null;
  insumos: RecetaInsumoInput[];
}

export async function upsertReceta(
  input: UpsertRecetaInput,
): Promise<{ data: RecetaConInsumos | null; error: string | null }> {
  // 1. Buscar receta viva activa para el item.
  const { data: existente } = await db
    .from('recetas')
    .select('id')
    .eq('item_id', input.itemId)
    .eq('activa', true)
    .is('deleted_at', null)
    .maybeSingle();

  let recetaId: number;

  if (existente) {
    // Update existente.
    recetaId = (existente as { id: number }).id;
    const { error } = await db
      .from('recetas')
      .update({
        nombre: input.nombre,
        rendimiento: input.rendimiento,
        notas: input.notas ?? null,
      })
      .eq('id', recetaId);
    if (error) return { data: null, error: translateError(error) };

    // Soft-delete los receta_insumos viejos.
    await db
      .from('receta_insumos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('receta_id', recetaId)
      .is('deleted_at', null);
  } else {
    // Crear nueva receta activa.
    const { data: created, error } = await db
      .from('recetas')
      .insert({
        tenant_id: input.tenantId,
        local_id: input.localId,
        item_id: input.itemId,
        nombre: input.nombre,
        rendimiento: input.rendimiento,
        notas: input.notas ?? null,
        activa: true,
      })
      .select('id')
      .single();
    if (error) return { data: null, error: translateError(error) };
    recetaId = (created as { id: number }).id;

    // Apuntar items.receta_id_vigente a esta receta.
    await db.from('items').update({ receta_id_vigente: recetaId }).eq('id', input.itemId);
  }

  // 2. Insertar los receta_insumos nuevos.
  if (input.insumos.length > 0) {
    const filas = input.insumos.map((ri, idx) => ({
      tenant_id: input.tenantId,
      receta_id: recetaId,
      insumo_id: ri.insumo_id,
      cantidad: ri.cantidad,
      merma_pct: ri.merma_pct ?? 0,
      notas: ri.notas ?? null,
      orden: ri.orden ?? idx,
    }));
    const { error: errIns } = await db.from('receta_insumos').insert(filas);
    if (errIns) return { data: null, error: errIns.message };
  }

  // 3. Devolver el resultado completo.
  return getRecetaConInsumos(recetaId);
}

// Calcula el costo total estimado de UNA porción de la receta.
// formula: sum(insumo.costo_actual × ri.cantidad × (1 + merma_pct/100)) / rendimiento
// Devuelve null si algún insumo no tiene costo_actual setteado (caso típico
// en setup inicial — los costos se llenan con Fase 1.2 PASE).
export function calcularCostoPorPorcion(receta: RecetaConInsumos): number | null {
  if (!receta.insumos || receta.insumos.length === 0) return 0;
  let total = 0;
  for (const ri of receta.insumos) {
    const costo = ri.insumo?.costo_actual;
    if (costo == null) return null;
    total += Number(costo) * Number(ri.cantidad) * (1 + Number(ri.merma_pct) / 100);
  }
  return total / Number(receta.rendimiento);
}
