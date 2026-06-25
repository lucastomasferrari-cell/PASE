// Parte operativo de turno — registra faltas, llegadas tarde, reclamos y
// comentario del encargado al cerrar caja.

import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

export interface ParteOperativoInput {
  localId: number;
  turnoId?: number;
  empleadosFalta: string[];  // ids de rrhh_empleados
  empleadosTarde: string[];
  reclamos: string | null;
  comentario: string | null;
  cerradoPor: string;        // id de rrhh_empleados
}

export interface ParteOperativo {
  id: number;
  tenant_id: string;
  local_id: number;
  turno_id: number | null;
  empleados_falta: string[];
  empleados_tarde: string[];
  reclamos: string | null;
  comentario: string | null;
  cerrado_por: string | null;
  created_at: string;
}

export async function crearParteOperativo(
  input: ParteOperativoInput,
): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db
    // eslint-disable-next-line pase-local/require-apply-local-scope -- local_id explícito en insert
    .from('partes_operativos')
    .insert({
      local_id: input.localId,
      turno_id: input.turnoId ?? null,
      empleados_falta: input.empleadosFalta,
      empleados_tarde: input.empleadosTarde,
      reclamos: input.reclamos,
      comentario: input.comentario,
      cerrado_por: input.cerradoPor,
    })
    .select('id')
    .single();
  if (error) return { id: null, error: translateError(error) };
  return { id: (data as { id: number }).id, error: null };
}

export async function listPartesOperativos(
  localId: number,
  limit = 30,
): Promise<{ data: ParteOperativo[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- filtro explícito por local_id
  const { data, error } = await db
    .from('partes_operativos')
    .select('*')
    .eq('local_id', localId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as ParteOperativo[], error: null };
}
