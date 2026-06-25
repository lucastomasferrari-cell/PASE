// rolesService — RBAC del tenant. Roles + permisos por rol (RolesPermisos.tsx
// de PASE porteado). Tablas: `roles` (catálogo) + `rol_permisos` (slugs por rol).

import { db } from './supabase';

export interface Rol {
  id: number;
  nombre: string;
  slug: string;        // 'dueno' | 'admin' | 'encargado' | 'cajero' | 'compras' | custom
  descripcion: string | null;
  sistema: boolean;    // si es true, no se puede borrar
  permisos: string[];
}

export async function listRoles(): Promise<{ data: Rol[]; error: string | null }> {
  const [r, rp] = await Promise.all([
    db().from('roles').select('id, nombre, slug, descripcion, sistema').order('nombre'),
    db().from('rol_permisos').select('rol_id, permiso'),
  ]);
  if (r.error) return { data: [], error: r.error.message };
  const permsByRol = new Map<number, string[]>();
  for (const x of (rp.data ?? []) as { rol_id: number; permiso: string }[]) {
    const arr = permsByRol.get(x.rol_id) ?? [];
    arr.push(x.permiso);
    permsByRol.set(x.rol_id, arr);
  }
  const data = ((r.data ?? []) as Omit<Rol, 'permisos'>[]).map((row) => ({
    ...row, permisos: permsByRol.get(row.id) ?? [],
  }));
  return { data, error: null };
}

export async function crearRol(input: { nombre: string; descripcion?: string }): Promise<{ id: number | null; error: string | null }> {
  const slug = input.nombre.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
  const { data, error } = await db().from('roles').insert({
    nombre: input.nombre.trim(), slug, descripcion: input.descripcion?.trim() ?? null, sistema: false,
  }).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: (data as { id: number }).id, error: null };
}

export async function setPermisosRol(rolId: number, slugs: string[]): Promise<{ error: string | null }> {
  const del = await db().from('rol_permisos').delete().eq('rol_id', rolId);
  if (del.error) return { error: del.error.message };
  if (slugs.length === 0) return { error: null };
  const rows = slugs.map((p) => ({ rol_id: rolId, permiso: p }));
  const { error } = await db().from('rol_permisos').insert(rows);
  return { error: error?.message ?? null };
}

export async function eliminarRol(rolId: number): Promise<{ error: string | null }> {
  const { error } = await db().from('roles').delete().eq('id', rolId).eq('sistema', false);
  return { error: error?.message ?? null };
}
