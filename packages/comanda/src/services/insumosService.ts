import { db } from '../lib/supabase';
import type { Insumo, UnidadInsumo } from '../types/database';
import { translateError } from '../lib/errors';

// Auto-86 CMV: setea stock_disponible del insumo. Trigger SQL marca items
// con recetas dependientes como agotado automáticamente.
export async function toggleStockInsumo(
  insumoId: number,
  disponible: boolean,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_toggle_stock_insumo', {
    p_insumo_id: insumoId,
    p_disponible: disponible,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

// Service de insumos (F1.1b — UI editor recetas).
// Insumos viven por tenant + opcionalmente por local (local_id NULL = global).
// RLS y UNIQUE parcial ya creados en migration F1.1.

export interface ListInsumosOpts {
  localId?: number | null; // null/undefined = todos los del tenant (globales + de todos los locales accesibles)
  search?: string;
  onlyActivos?: boolean;
  limit?: number;
}

export async function listInsumos(
  opts: ListInsumosOpts = {},
): Promise<{ data: Insumo[]; error: string | null }> {
  let q = db
    .from('insumos')
    .select('*')
    .is('deleted_at', null)
    .order('nombre', { ascending: true })
    .limit(opts.limit ?? 200);

  if (opts.localId != null) {
    // Pedidos para un local específico: incluir el local + los globales (NULL).
    q = q.or(`local_id.eq.${opts.localId},local_id.is.null`);
  }
  if (opts.onlyActivos !== false) {
    q = q.eq('activo', true);
  }
  if (opts.search?.trim()) {
    q = q.ilike('nombre', `%${opts.search.trim()}%`);
  }

  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Insumo[], error: null };
}

export async function getInsumo(id: number): Promise<{ data: Insumo | null; error: string | null }> {
  const { data, error } = await db
    .from('insumos').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Insumo | null, error: null };
}

export interface InsumoInput {
  nombre: string;
  unidad: UnidadInsumo;
  descripcion?: string | null;
  emoji?: string | null;
  foto_url?: string | null;
  costo_actual?: number | null;
  activo?: boolean;
  es_comprado?: boolean;
  local_id?: number | null;
}

export async function createInsumo(
  tenantId: string,
  input: InsumoInput,
): Promise<{ data: Insumo | null; error: string | null }> {
  // costo_actualizado_at se setea automático si se manda costo_actual.
  const payload: Record<string, unknown> = { tenant_id: tenantId, ...input };
  if (input.costo_actual != null) {
    payload.costo_actualizado_at = new Date().toISOString();
  }
  const { data, error } = await db
    .from('insumos').insert(payload).select('*').single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Insumo, error: null };
}

export async function updateInsumo(
  id: number,
  patch: Partial<InsumoInput>,
): Promise<{ data: Insumo | null; error: string | null }> {
  // Si actualiza costo_actual, setear costo_actualizado_at.
  const payload: Record<string, unknown> = { ...patch };
  if (patch.costo_actual !== undefined) {
    payload.costo_actualizado_at = new Date().toISOString();
  }
  const { data, error } = await db
    .from('insumos').update(payload).eq('id', id).select('*').single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Insumo, error: null };
}

export async function softDeleteInsumo(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('insumos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// ═══════════════════════════════════════════════════════════════════════
// Stock numérico — movimientos, ajustes, conteos físicos, alertas.
// Sprint 2026-05-20.
// ═══════════════════════════════════════════════════════════════════════

export type TipoMovimientoStock =
  | 'entrada_compra' | 'entrada_ajuste' | 'entrada_devolucion'
  | 'salida_venta' | 'salida_ajuste'
  | 'merma' | 'robo' | 'donacion'
  | 'conteo' | 'inicial';

export type TipoAjusteManual =
  | 'entrada_ajuste' | 'salida_ajuste' | 'merma' | 'robo' | 'donacion';

export interface InsumoMovimiento {
  id: number;
  insumo_id: number;
  tipo: TipoMovimientoStock;
  cantidad: number;
  costo_unitario: number | null;
  motivo: string | null;
  fuente_tipo: string | null;
  fuente_id: number | null;
  usuario_id: number | null;
  manager_id: number | null;
  stock_antes: number | null;
  stock_despues: number | null;
  created_at: string;
}

export async function listMovimientosInsumo(
  insumoId: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ data: InsumoMovimiento[]; error: string | null }> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS por insumo->tenant
  const { data, error } = await db
    .from('insumo_movimientos')
    .select('*')
    .eq('insumo_id', insumoId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as InsumoMovimiento[], error: null };
}

export async function ajustarStockInsumo(args: {
  insumoId: number;
  cantidad: number;       // positivo = entrada, negativo = salida
  tipo: TipoAjusteManual;
  motivo: string;
  managerId?: number;
}): Promise<{ data: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_ajustar_stock_insumo', {
    p_insumo_id: args.insumoId,
    p_cantidad: args.cantidad,
    p_tipo: args.tipo,
    p_motivo: args.motivo,
    p_manager_id: args.managerId ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  return { data: data as number, error: null };
}

export interface AlertaStock {
  id: number;
  local_id: number | null;
  nombre: string;
  unidad: string;
  emoji: string | null;
  stock_actual: number;
  stock_minimo: number | null;
  stock_maximo: number | null;
  costo_actual: number | null;
  alerta_nivel: 'agotado' | 'bajo' | 'sobrestock' | 'ok';
  dias_estimados_restantes: number | null;
}

export async function listAlertasStock(
  filterNivel?: 'agotado' | 'bajo' | 'sobrestock',
): Promise<{ data: AlertaStock[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
  let q = db.from('v_insumos_alertas_stock').select('*');
  if (filterNivel) q = q.eq('alerta_nivel', filterNivel);
  else q = q.in('alerta_nivel', ['agotado', 'bajo', 'sobrestock']);
  q = q.order('alerta_nivel', { ascending: true }).order('nombre', { ascending: true });
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as AlertaStock[], error: null };
}

export interface RotacionStock {
  insumo_id: number;
  local_id: number | null;
  nombre: string;
  unidad: string;
  costo_actual: number | null;
  stock_actual: number;
  consumido_30d: number;
  perdido_30d: number;
  comprado_30d: number;
  valor_consumido_30d: number;
}

export async function listRotacionStock(): Promise<{ data: RotacionStock[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
  const { data, error } = await db
    .from('v_stock_rotacion_30d')
    .select('*')
    .order('valor_consumido_30d', { ascending: false })
    .limit(200);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as RotacionStock[], error: null };
}

// ─── Conteo físico ────────────────────────────────────────────────────

export interface StockConteo {
  id: number;
  local_id: number;
  iniciado_por: number;
  finalizado_por: number | null;
  estado: 'abierto' | 'finalizado' | 'cancelado';
  notas: string | null;
  iniciado_at: string;
  finalizado_at: string | null;
  total_insumos: number;
  total_ajustes: number;
  valor_diferencia: number;
}

export interface StockConteoLinea {
  id: number;
  conteo_id: number;
  insumo_id: number;
  stock_teorico: number;
  stock_contado: number | null;
  diferencia: number;
  notas: string | null;
  contado_at: string | null;
  contado_por: number | null;
  // Joined desde insumos
  insumo_nombre?: string;
  insumo_unidad?: string;
  insumo_costo?: number | null;
  insumo_ubicacion?: string | null;
}

export async function listConteos(localId: number): Promise<{ data: StockConteo[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS filtra
  const { data, error } = await db
    .from('stock_conteos')
    .select('*')
    .eq('local_id', localId)
    .order('iniciado_at', { ascending: false });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as StockConteo[], error: null };
}

export async function iniciarConteoFisico(
  localId: number,
  notas?: string,
): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_iniciar_conteo_fisico', {
    p_local_id: localId,
    p_notas: notas ?? null,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: data as number, error: null };
}

export async function listConteoLineas(
  conteoId: number,
): Promise<{ data: StockConteoLinea[]; error: string | null }> {
  // Trae líneas + datos del insumo joined
  const { data, error } = await db
    .from('stock_conteo_lineas')
    .select('*, insumos(nombre, unidad, costo_actual, ubicacion)')
    .eq('conteo_id', conteoId)
    .order('insumo_id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  const rows = (data ?? []) as Array<StockConteoLinea & {
    insumos: { nombre: string; unidad: string; costo_actual: number | null; ubicacion: string | null } | null;
  }>;
  return {
    data: rows.map((r) => ({
      ...r,
      insumo_nombre: r.insumos?.nombre,
      insumo_unidad: r.insumos?.unidad,
      insumo_costo: r.insumos?.costo_actual ?? null,
      insumo_ubicacion: r.insumos?.ubicacion ?? null,
    })),
    error: null,
  };
}

export async function cargarConteoLinea(args: {
  conteoId: number;
  insumoId: number;
  stockContado: number;
  notas?: string;
}): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_cargar_conteo_linea', {
    p_conteo_id: args.conteoId,
    p_insumo_id: args.insumoId,
    p_stock_contado: args.stockContado,
    p_notas: args.notas ?? null,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function finalizarConteoFisico(
  conteoId: number,
): Promise<{ data: { ajustes: number; diferencia_valor: number; movs_durante: number } | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_finalizar_conteo_fisico', { p_conteo_id: conteoId });
  if (error) return { data: null, error: translateError(error) };
  // Desde migration 202605260200, el RPC devuelve ademas movs_durante
  // (cantidad de movs venta/merma/compra que ocurrieron entre iniciado_at
  // y finalizado_at). Si > 0, el ajuste puede descuadrar.
  const arr = data as Array<{ ajustes: number; diferencia_valor: number; movs_durante: number }> | null;
  return { data: arr?.[0] ?? null, error: null };
}
