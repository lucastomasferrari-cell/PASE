// Service para mermas — usa el catálogo `mermas_motivos` y la RPC
// fn_registrar_merma creados en migration 202605211700.
//
// Visión PASE original: "Función One-Tap: Una lista de los 10 insumos
// que más se tiran. El cocinero toca el ítem, pone la cantidad y
// selecciona el motivo."
//
// Tipos de motivo (mermas_motivos.tipo_movimiento):
//   - merma        → desperdicio técnico, error de cocina, vencimiento
//   - donacion     → consumo de personal, cortesía cliente
//   - salida_ajuste→ ajuste por conteo
//   - robo         → sospecha de robo (requiere manager_id)

import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

export interface MermaMotivo {
  id: number;
  nombre: string;
  descripcion: string | null;
  tipo_movimiento: 'merma' | 'donacion' | 'salida_ajuste' | 'robo';
  orden: number;
  activo: boolean;
  emoji: string | null;
}

export interface MermaTopInsumo {
  insumo_id: number;
  insumo_nombre: string;
  unidad: string;
  veces_mermado: number;
  cantidad_total: number;
  valor_total: number;
  ultima_merma: string;
}

export async function listMotivos(): Promise<{ data: MermaMotivo[]; error: string | null }> {
  const { data, error } = await db
    .from('mermas_motivos')
    .select('id, nombre, descripcion, tipo_movimiento, orden, activo, emoji')
    .eq('activo', true)
    .is('deleted_at', null)
    .order('orden', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MermaMotivo[], error: null };
}

export async function listTop10Mermados(
  localId: number,
): Promise<{ data: MermaTopInsumo[]; error: string | null }> {
  const { data, error } = await db
    .from('v_mermas_top10')
    .select('insumo_id, insumo_nombre, unidad, veces_mermado, cantidad_total, valor_total, ultima_merma')
    .eq('local_id', localId)
    .limit(10);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MermaTopInsumo[], error: null };
}

export async function registrarMerma(opts: {
  insumoId: number;
  localId: number;
  cantidad: number;
  motivoId: number;
  notas?: string;
  managerId?: number;  // requerido si motivo.tipo_movimiento === 'robo'
}): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_registrar_merma', {
    p_insumo_id: opts.insumoId,
    p_local_id: opts.localId,
    p_cantidad: opts.cantidad,
    p_motivo_id: opts.motivoId,
    p_notas: opts.notas ?? null,
    p_manager_id: opts.managerId ?? null,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: data as number, error: null };
}
