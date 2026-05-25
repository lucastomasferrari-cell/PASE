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

// ─── Importador bulk ────────────────────────────────────────────────────────
// Carga masiva desde CSV. La RPC `fn_importar_recetas_bulk` valida + agrupa
// por plato + crea items/insumos faltantes en transacción única.
//
// Patrón de uso: 1) parsear CSV en cliente, 2) llamar con dry_run=true para
// preview, 3) si el usuario confirma, llamar con dry_run=false.

export type LineaImportRecetas = {
  plato: string;
  ingrediente: string;
  cantidad: number;
  unidad: string;
  merma_pct?: number;
  precio_plato?: number | null;
};

export type ReporteImport = {
  ok: boolean;
  dry_run: boolean;
  filas_total: number;
  recetas_a_crear?: number;
  items_a_crear?: number;
  insumos_a_crear?: number;
  recetas_creadas?: number;
  items_creados?: number;
  insumos_creados?: number;
  items_nuevos?: string[];
  insumos_nuevos?: string[];
  errores: Array<{
    linea: number;
    plato?: string;
    ingrediente?: string;
    error: string;
    recibido?: unknown;
    validas?: string[];
  }>;
};

export async function importarRecetasBulk(
  lineas: LineaImportRecetas[],
  opts: { dryRun: boolean; idempotencyKey?: string },
): Promise<{ data: ReporteImport | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_importar_recetas_bulk', {
    p_recetas: lineas,
    p_dry_run: opts.dryRun,
    p_idempotency_key: opts.idempotencyKey ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  return { data: data as ReporteImport, error: null };
}

// Parsea CSV (con header en la primera fila). Tolerante a:
//   - separador `,` o `;` (Excel ES exporta con ;)
//   - filas vacías al final
//   - espacios extra
// Columnas esperadas (header): plato, ingrediente, cantidad, unidad, merma_pct, precio_plato
// Las 4 primeras son obligatorias; merma_pct y precio_plato opcionales.
export function parsearCsvRecetas(csv: string): { data: LineaImportRecetas[]; error: string | null } {
  const lineas = csv.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lineas.length < 2) return { data: [], error: 'CSV vacío o solo header' };

  // Detectar separador del header
  const headerLine = lineas[0] ?? '';
  const sep = headerLine.includes(';') ? ';' : ',';
  const cols = headerLine.split(sep).map(c => c.trim().toLowerCase());

  const idx = {
    plato: cols.indexOf('plato'),
    ingrediente: cols.indexOf('ingrediente'),
    cantidad: cols.indexOf('cantidad'),
    unidad: cols.indexOf('unidad'),
    merma_pct: cols.indexOf('merma_pct'),
    precio_plato: cols.indexOf('precio_plato'),
  };
  if (idx.plato === -1 || idx.ingrediente === -1 || idx.cantidad === -1 || idx.unidad === -1) {
    return { data: [], error: 'Header debe incluir: plato, ingrediente, cantidad, unidad' };
  }

  const data: LineaImportRecetas[] = [];
  for (let i = 1; i < lineas.length; i++) {
    const row = (lineas[i] ?? '').split(sep).map(c => c.trim());
    const get = (j: number) => (j >= 0 && j < row.length ? (row[j] ?? '') : '');
    const cantidadStr = get(idx.cantidad).replace(',', '.');
    const mermaStr = idx.merma_pct >= 0 ? get(idx.merma_pct).replace(',', '.') : '';
    const precioStr = idx.precio_plato >= 0 ? get(idx.precio_plato).replace(',', '.') : '';
    data.push({
      plato: get(idx.plato),
      ingrediente: get(idx.ingrediente),
      cantidad: Number(cantidadStr),
      unidad: get(idx.unidad),
      merma_pct: mermaStr ? Number(mermaStr) : 0,
      precio_plato: precioStr ? Number(precioStr) : null,
    });
  }
  return { data, error: null };
}

// Calcula el costo total estimado de UNA porción de la receta.
// formula: sum(insumo.costo_actual × ri.cantidad × (1 + merma_pct/100)) / rendimiento
//
// Casos del retorno:
//   - null: no calculable (receta sin insumos, o algún insumo sin costo, o
//     rendimiento <= 0). El caller debe mostrar "no calculable" — NO usar 0
//     como fallback porque sería "falsa precisión" (vendés a $5000 con costo
//     0 → margen 100% mostrado, pero el costo real es desconocido).
//   - number: costo válido por porción.
export function calcularCostoPorPorcion(receta: RecetaConInsumos): number | null {
  if (!receta.insumos || receta.insumos.length === 0) return null;
  if (!receta.rendimiento || Number(receta.rendimiento) <= 0) return null;
  let total = 0;
  for (const ri of receta.insumos) {
    const costo = ri.insumo?.costo_actual;
    if (costo == null) return null;
    total += Number(costo) * Number(ri.cantidad) * (1 + Number(ri.merma_pct) / 100);
  }
  return total / Number(receta.rendimiento);
}
