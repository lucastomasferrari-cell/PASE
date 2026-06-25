// rolesService — RBAC del tenant. Roles + permisos por rol (RolesPermisos.tsx
// de PASE porteado). Tablas: `roles` (catálogo) + `rol_permisos` (slugs por rol).
//
// Schema real (migración 202605201900):
//   roles.id UUID, roles.es_sistema BOOLEAN
//   rol_permisos: (rol_id UUID, modulo_slug TEXT)

import { db } from './supabase';

export interface Rol {
  id: string;          // UUID
  nombre: string;
  slug: string;        // 'dueno' | 'admin' | 'encargado' | 'cajero' | 'compras' | custom
  descripcion: string | null;
  sistema: boolean;    // mapea a `es_sistema` en DB (si true, no se puede borrar)
  permisos: string[];
}

export async function listRoles(): Promise<{ data: Rol[]; error: string | null }> {
  const [r, rp] = await Promise.all([
    db().from('roles').select('id, nombre, slug, descripcion, es_sistema').order('nombre'),
    db().from('rol_permisos').select('rol_id, modulo_slug'),
  ]);
  if (r.error) return { data: [], error: r.error.message };
  const permsByRol = new Map<string, string[]>();
  for (const x of (rp.data ?? []) as { rol_id: string; modulo_slug: string }[]) {
    const arr = permsByRol.get(x.rol_id) ?? [];
    arr.push(x.modulo_slug);
    permsByRol.set(x.rol_id, arr);
  }
  const data = ((r.data ?? []) as Array<{ id: string; nombre: string; slug: string; descripcion: string | null; es_sistema: boolean }>).map((row) => ({
    id: row.id,
    nombre: row.nombre,
    slug: row.slug,
    descripcion: row.descripcion,
    sistema: row.es_sistema,
    permisos: permsByRol.get(row.id) ?? [],
  }));
  return { data, error: null };
}

export async function crearRol(input: { nombre: string; descripcion?: string }): Promise<{ id: string | null; error: string | null }> {
  const slug = input.nombre.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
  const { data, error } = await db().from('roles').insert({
    nombre: input.nombre.trim(), slug, descripcion: input.descripcion?.trim() ?? null, es_sistema: false,
  }).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string }).id, error: null };
}

export async function setPermisosRol(rolId: string, slugs: string[]): Promise<{ error: string | null }> {
  const del = await db().from('rol_permisos').delete().eq('rol_id', rolId);
  if (del.error) return { error: del.error.message };
  if (slugs.length === 0) return { error: null };
  const rows = slugs.map((p) => ({ rol_id: rolId, modulo_slug: p }));
  const { error } = await db().from('rol_permisos').insert(rows);
  return { error: error?.message ?? null };
}

export async function eliminarRol(rolId: string): Promise<{ error: string | null }> {
  const { error } = await db().from('roles').delete().eq('id', rolId).eq('es_sistema', false);
  return { error: error?.message ?? null };
}
