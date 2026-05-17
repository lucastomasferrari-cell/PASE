import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

// Sprint 2 competitor F #7 — Manager Logbook.
// Diario digital del manager: novedades del turno que el próximo turno tiene
// que leer. Pendientes pasan hasta que alguien los marca resueltos.

export type LogbookCategoria = 'caja' | 'cocina' | 'cliente' | 'empleado' | 'proveedor' | 'general';
export type LogbookPrioridad = 'info' | 'atencion' | 'urgente';

export interface LogbookEntry {
  id: number;
  tenant_id: string;
  local_id: number;
  created_at: string;
  updated_at: string;
  autor_empleado_id: string | null;
  autor_nombre: string | null;
  categoria: LogbookCategoria;
  prioridad: LogbookPrioridad;
  texto: string;
  pendiente: boolean;
  resuelto_at: string | null;
  resuelto_por_id: string | null;
  resuelto_nombre: string | null;
  resolucion_nota: string | null;
}

export async function listLogbook(
  localId: number,
  filter: 'pendientes' | 'todas' = 'pendientes',
  limit = 100,
): Promise<{ data: LogbookEntry[]; error: string | null }> {
  let q = db
    .from('manager_logbook')
    .select('*')
    .eq('local_id', localId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter === 'pendientes') q = q.eq('pendiente', true);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as LogbookEntry[], error: null };
}

export async function crearLogbook(args: {
  localId: number;
  empleadoId: string;
  categoria: LogbookCategoria;
  prioridad: LogbookPrioridad;
  texto: string;
  pendiente?: boolean;
}): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_logbook_crear', {
    p_local_id: args.localId,
    p_empleado_id: args.empleadoId,
    p_categoria: args.categoria,
    p_prioridad: args.prioridad,
    p_texto: args.texto,
    p_pendiente: args.pendiente ?? true,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: (data as number | null) ?? null, error: null };
}

export async function resolverLogbook(
  id: number,
  empleadoId: string,
  nota?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_logbook_resolver', {
    p_id: id,
    p_empleado_id: empleadoId,
    p_nota: nota ?? null,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}
