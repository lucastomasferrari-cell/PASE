// posService — empleados POS de COMANDA (PIN). Permite al dueño definir
// quién puede entrar al POS, asignar rol_pos (cajero/mozo/admin) y resetear
// el PIN. Tabla `rrhh_empleados` + RPC `fn_set_pin_pos`.

import { db } from './supabase';

export interface EmpleadoPos {
  id: string;
  local_id: number;
  apellido: string | null;
  nombre: string | null;
  puesto: string | null;
  activo: boolean;
  pos_activo: boolean;
  rol_pos: 'cajero' | 'mozo' | 'admin' | null;
  pin_actualizado_at: string | null;
}

export async function listEmpleadosPos(localId: number | null): Promise<{ data: EmpleadoPos[]; error: string | null }> {
  let q = db()
    .from('rrhh_empleados')
    .select('id, local_id, apellido, nombre, puesto, activo, pos_activo, rol_pos, pin_actualizado_at')
    .eq('activo', true)
    .order('apellido', { ascending: true });
  if (localId !== null) q = q.eq('local_id', localId);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as EmpleadoPos[], error: null };
}

export async function setPosActivo(empleadoId: string, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db().from('rrhh_empleados').update({ pos_activo: activo }).eq('id', empleadoId);
  return { error: error?.message ?? null };
}

export async function setRolPos(empleadoId: string, rol: 'cajero' | 'mozo' | 'admin' | null): Promise<{ error: string | null }> {
  const { error } = await db().from('rrhh_empleados').update({ rol_pos: rol }).eq('id', empleadoId);
  return { error: error?.message ?? null };
}

export async function setPin(empleadoId: string, pin: string): Promise<{ error: string | null }> {
  if (!/^\d{4}$/.test(pin)) return { error: 'El PIN debe ser exactamente 4 dígitos' };
  const { error } = await db().rpc('fn_set_pin_pos', { p_empleado_id: empleadoId, p_pin: pin });
  return { error: error?.message ?? null };
}
