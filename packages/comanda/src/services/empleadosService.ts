import { db } from '../lib/supabase';
import type { EmpleadoPos, RolPos } from '../types/database';
import { translateError } from '../lib/errors';

// Lista TODOS los empleados activos del local (con o sin PIN), para Settings.
export async function listEmpleadosLocal(localId: number): Promise<{ data: EmpleadoPos[]; error: string | null }> {
  const { data, error } = await db
    .from('rrhh_empleados')
    .select('id, local_id, apellido, nombre, puesto, activo, pos_activo, rol_pos, pin_actualizado_at')
    .eq('local_id', localId)
    .eq('activo', true)
    .order('apellido', { ascending: true })
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as EmpleadoPos[], error: null };
}

// Lista empleados POS-activos del local (con PIN seteado). Para PinPad.
export async function listEmpleadosPosActivos(localId: number): Promise<{ data: EmpleadoPos[]; error: string | null }> {
  const { data, error } = await db
    .from('rrhh_empleados')
    .select('id, local_id, apellido, nombre, puesto, activo, pos_activo, rol_pos, pin_actualizado_at')
    .eq('local_id', localId)
    .eq('activo', true)
    .eq('pos_activo', true)
    .not('pin_actualizado_at', 'is', null)
    .order('apellido', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as EmpleadoPos[], error: null };
}

export async function setRolPos(empleadoId: string, rol: RolPos | null): Promise<{ error: string | null }> {
  const { error } = await db.from('rrhh_empleados').update({ rol_pos: rol }).eq('id', empleadoId);
  return { error: error?.message ?? null };
}

export async function setPosActivo(empleadoId: string, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db.from('rrhh_empleados').update({ pos_activo: activo }).eq('id', empleadoId);
  return { error: error?.message ?? null };
}

export async function setPin(empleadoId: string, pin: string): Promise<{ error: string | null }> {
  if (!/^\d{4}$/.test(pin)) return { error: 'El PIN debe ser exactamente 4 dígitos' };
  const { error } = await db.rpc('fn_set_pin_pos', {
    p_empleado_id: empleadoId,
    p_pin: pin,
  });
  return { error: error?.message ?? null };
}

// Verifica PIN: retorna empleado_id si OK, null si no.
export async function verificarPin(localId: number, pin: string): Promise<{ empleadoId: string | null; error: string | null }> {
  if (!/^\d{4}$/.test(pin)) return { empleadoId: null, error: 'PIN inválido' };
  const { data, error } = await db.rpc('fn_verificar_pin_pos', {
    p_local_id: localId,
    p_pin: pin,
  });
  if (error) return { empleadoId: null, error: translateError(error) };
  return { empleadoId: (data as string | null) ?? null, error: null };
}

// Trae info pública del empleado (para mostrar nombre + rol_pos tras verificar)
export async function getEmpleado(empleadoId: string): Promise<{ data: EmpleadoPos | null; error: string | null }> {
  const { data, error } = await db
    .from('rrhh_empleados')
    .select('id, local_id, apellido, nombre, puesto, activo, pos_activo, rol_pos, pin_actualizado_at, pos_favoritos')
    .eq('id', empleadoId)
    .limit(1)
    .single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as EmpleadoPos, error: null };
}

// Sprint 16/05: toggle favorito Quick Items del empleado actual.
// Devuelve el nuevo array de favoritos (item_ids) para que el caller
// actualice su state local sin re-fetch.
export async function toggleFavoritoPos(
  empleadoId: string,
  itemId: number,
): Promise<{ favoritos: number[] | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_toggle_favorito_pos', {
    p_empleado_id: empleadoId,
    p_item_id: itemId,
  });
  if (error) return { favoritos: null, error: error.message };
  return { favoritos: (data ?? []) as number[], error: null };
}
