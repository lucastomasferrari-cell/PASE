import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

export interface MateriaPrima {
  id: number;
  tenant_id: string;
  nombre: string;
  proveedor_id: number | null;
  insumo_id: number;
  unidad_compra: string;
  factor_conversion: number;
  precio_actual: number | null;
  precio_actualizado_at: string | null;
  notas: string | null;
  activa: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Joins enriquecidos
  insumo_nombre?: string;
  insumo_unidad?: string;
  proveedor_nombre?: string | null;
}

export interface MateriaPrimaInput {
  nombre: string;
  proveedor_id?: number | null;
  insumo_id: number;
  unidad_compra: string;
  factor_conversion: number;
  precio_actual?: number | null;
  notas?: string | null;
  activa?: boolean;
}

export async function listMateriasPrimas(opts: { insumoId?: number; soloActivas?: boolean; search?: string } = {}): Promise<{ data: MateriaPrima[]; error: string | null }> {
  let q = db.from('materias_primas')
    .select(`
      *,
      insumo:insumos(nombre, unidad),
      proveedor:proveedores(nombre)
    `)
    .is('deleted_at', null)
    .order('nombre', { ascending: true });
  if (opts.insumoId) q = q.eq('insumo_id', opts.insumoId);
  if (opts.soloActivas) q = q.eq('activa', true);
  if (opts.search) q = q.ilike('nombre', `%${opts.search}%`);
  const { data, error } = await q.limit(500);
  if (error) return { data: [], error: translateError(error) };
  const mapped: MateriaPrima[] = (data ?? []).map((r) => {
    const row = r as MateriaPrima & {
      insumo?: { nombre: string; unidad: string } | { nombre: string; unidad: string }[] | null;
      proveedor?: { nombre: string } | { nombre: string }[] | null;
    };
    const insumo = Array.isArray(row.insumo) ? row.insumo[0] : row.insumo;
    const prov = Array.isArray(row.proveedor) ? row.proveedor[0] : row.proveedor;
    return {
      ...row,
      insumo_nombre: insumo?.nombre,
      insumo_unidad: insumo?.unidad,
      proveedor_nombre: prov?.nombre ?? null,
    };
  });
  return { data: mapped, error: null };
}

export async function createMateriaPrima(tenantId: string, input: MateriaPrimaInput): Promise<{ data: MateriaPrima | null; error: string | null }> {
  const { data, error } = await db.from('materias_primas')
    .insert({ tenant_id: tenantId, ...input })
    .select('*').single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as MateriaPrima, error: null };
}

export async function updateMateriaPrima(id: number, patch: Partial<MateriaPrimaInput>): Promise<{ data: MateriaPrima | null; error: string | null }> {
  const { data, error } = await db.from('materias_primas')
    .update(patch).eq('id', id).select('*').single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as MateriaPrima, error: null };
}

export async function softDeleteMateriaPrima(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('materias_primas')
    .update({ deleted_at: new Date().toISOString(), activa: false }).eq('id', id);
  if (error) return { error: translateError(error) };
  return { error: null };
}

// Costo "as-bought" de una MP en términos del insumo unificado.
// precio_actual / factor_conversion. La merma/rendimiento NO se aplica acá —
// vive en la línea de receta (receta_insumos.merma_pct), al consumir.
export function calcCostoEfectivo(mp: { precio_actual: number | null; factor_conversion: number }): number | null {
  if (!mp.precio_actual || mp.precio_actual <= 0) return null;
  const factor = Number(mp.factor_conversion) || 1;
  if (factor <= 0) return null;
  return mp.precio_actual / factor;
}
