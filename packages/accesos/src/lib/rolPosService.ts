// Roles del POS (PIN) — permisos por rol_pos en `rol_pos_permisos` (global).
// Lectura directa (RLS: SELECT abierto). Escritura vía RPC fn_set_rol_pos_permisos
// (dueño/admin). '*' = acceso total (dueño).

import { db } from './supabase';
import { ROLES_POS, type RolPos } from './permisosRolPos';

export async function listRolPosPermisos(): Promise<{ data: Record<RolPos, string[]>; error: string | null }> {
  const { data, error } = await db().from('rol_pos_permisos').select('rol_pos, slug').eq('activo', true);
  if (error) return { data: {} as Record<RolPos, string[]>, error: error.message };
  const out = {} as Record<RolPos, string[]>;
  for (const r of ROLES_POS) out[r] = [];
  for (const row of (data ?? []) as { rol_pos: string; slug: string }[]) {
    if ((ROLES_POS as readonly string[]).includes(row.rol_pos)) {
      out[row.rol_pos as RolPos].push(row.slug);
    }
  }
  return { data: out, error: null };
}

export async function setRolPosPermisos(rolPos: RolPos, slugs: string[]): Promise<{ error: string | null }> {
  const { error } = await db().rpc('fn_set_rol_pos_permisos', { p_rol_pos: rolPos, p_slugs: slugs });
  return { error: error?.message ?? null };
}
