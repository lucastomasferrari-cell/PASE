// marcasService — ABM de marcas del grupo (multi-marca). Una MARCA agrupa
// locales dentro del tenant. Cada local pertenece a una marca (locales.marca_id).
// Tablas: `marcas` (202606301700), `locales.marca_id`.
//
// El insert NO pasa tenant_id: la columna tiene DEFAULT auth_tenant_id().

import { db } from './supabase';

export interface Marca {
  id: number;
  nombre: string;
  slug: string;
  color_primary: string | null;
  logo_url: string | null;
  orden: number;
  activo: boolean;
}

export interface LocalConMarca {
  id: number;
  nombre: string;
  marca_id: number | null;
}

export async function listMarcas(): Promise<{ data: Marca[]; error: string | null }> {
  const { data, error } = await db()
    .from('marcas')
    .select('id, nombre, slug, color_primary, logo_url, orden, activo')
    .is('deleted_at', null)
    .order('orden');
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Marca[], error: null };
}

export async function listLocalesConMarca(): Promise<{ data: LocalConMarca[]; error: string | null }> {
  // Nota: la tabla `locales` no tiene deleted_at (no usamos soft-delete acá).
  const { data, error } = await db()
    .from('locales')
    .select('id, nombre, marca_id')
    .order('nombre');
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as LocalConMarca[], error: null };
}

export async function crearMarca(input: { nombre: string; color?: string | null }): Promise<{ id: number | null; error: string | null }> {
  const slug = input.nombre.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
  if (!slug) return { id: null, error: 'Nombre inválido' };
  const { data, error } = await db()
    .from('marcas')
    .insert({ nombre: input.nombre.trim(), slug, color_primary: input.color ?? null })
    .select('id')
    .single();
  if (error) return { id: null, error: error.message };
  return { id: (data as { id: number }).id, error: null };
}

export async function actualizarMarca(
  id: number,
  patch: { nombre?: string; color_primary?: string | null; activo?: boolean },
): Promise<{ error: string | null }> {
  const { error } = await db()
    .from('marcas')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error?.message ?? null };
}

export async function eliminarMarca(id: number): Promise<{ error: string | null }> {
  // Soft delete. Los locales que la tenían quedan sin marca (marca_id NULL).
  const desasignar = await db().from('locales').update({ marca_id: null }).eq('marca_id', id);
  if (desasignar.error) return { error: desasignar.error.message };
  const { error } = await db()
    .from('marcas')
    .update({ deleted_at: new Date().toISOString(), activo: false })
    .eq('id', id);
  return { error: error?.message ?? null };
}

// Asigna un local a una marca (o lo deja sin marca con null).
export async function setMarcaDeLocal(localId: number, marcaId: number | null): Promise<{ error: string | null }> {
  const { error } = await db().from('locales').update({ marca_id: marcaId }).eq('id', localId);
  return { error: error?.message ?? null };
}
