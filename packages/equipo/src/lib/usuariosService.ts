// usuariosService — gestión de usuarios del tenant (porteado de PASE).
// Tabla `usuarios` (perfil) + `usuario_permisos` (permisos por slug) +
// `usuario_locales` (locales asignados). La columna `apps_permitidas`
// (migración 202606250700) controla a qué apps del ecosistema entra.

import { db } from './supabase';

export interface Usuario {
  id: number;
  email: string;
  nombre: string;
  rol: string;                 // dueno / admin / encargado / cajero / compras / etc
  activo: boolean;
  password_temporal: boolean;
  cuentas_visibles: string[] | null;
  cuentas_operables?: string[] | null;
  rol_id?: number | null;       // FK a tabla roles (RBAC)
  apps_permitidas?: string[];   // 'pase' | 'comanda' | 'mesa' | 'habitue' | 'equipo'
  permisos?: string[];          // resuelto vía LEFT JOIN
  locales?: number[];           // ids de locales asignados
  created_at?: string;
}

// COLS = '*' para no romper si apps_permitidas todavía no está migrada.
const COLS = '*';

export async function listUsuarios(): Promise<{ data: Usuario[]; error: string | null }> {
  // Hago 3 queries en paralelo y armo el modelo combinado.
  const [u, perms, locs] = await Promise.all([
    db().from('usuarios').select(COLS).order('nombre'),
    db().from('usuario_permisos').select('usuario_id, permiso'),
    db().from('usuario_locales').select('usuario_id, local_id'),
  ]);
  if (u.error) return { data: [], error: u.error.message };

  const permByUser = new Map<number, string[]>();
  for (const r of (perms.data ?? []) as { usuario_id: number; permiso: string }[]) {
    const arr = permByUser.get(r.usuario_id) ?? [];
    arr.push(r.permiso);
    permByUser.set(r.usuario_id, arr);
  }
  const locByUser = new Map<number, number[]>();
  for (const r of (locs.data ?? []) as { usuario_id: number; local_id: number }[]) {
    const arr = locByUser.get(r.usuario_id) ?? [];
    arr.push(r.local_id);
    locByUser.set(r.usuario_id, arr);
  }

  const data = ((u.data ?? []) as Usuario[]).map((x) => ({
    ...x,
    permisos: permByUser.get(x.id) ?? [],
    locales: locByUser.get(x.id) ?? [],
  }));
  return { data, error: null };
}

export interface UsuarioInput {
  email: string;
  nombre: string;
  rol: string;
  password: string;
  apps_permitidas?: string[];
  cuentas_visibles?: string[] | null;
  rol_id?: number | null;
}

// Crea usuario en Auth + perfil en `usuarios`. Usa la RPC oficial si está
// disponible; cae a llamada al endpoint admin de PASE como fallback.
export async function crearUsuario(input: UsuarioInput): Promise<{ id: number | null; error: string | null }> {
  // Path A: RPC `fn_crear_usuario` (si existe en la base) — way faster.
  const { data, error } = await db().rpc('fn_crear_usuario', {
    p_email: input.email.trim(),
    p_nombre: input.nombre.trim(),
    p_rol: input.rol,
    p_password: input.password,
    p_apps_permitidas: input.apps_permitidas ?? ['pase'],
    p_cuentas_visibles: input.cuentas_visibles ?? null,
    p_rol_id: input.rol_id ?? null,
  });
  if (error) {
    // Mensaje claro si la RPC no existe todavía.
    if (/function .* does not exist/i.test(error.message)) {
      return { id: null, error: 'El alta de usuario necesita la RPC fn_crear_usuario en la base. Pasalo a Lucas para que la cree.' };
    }
    return { id: null, error: error.message };
  }
  return { id: Number(data), error: null };
}

export async function actualizarUsuario(id: number, patch: Partial<Usuario>): Promise<{ error: string | null }> {
  // Campos editables directos:
  const upd: Record<string, unknown> = {};
  if (patch.nombre !== undefined) upd.nombre = patch.nombre;
  if (patch.rol !== undefined) upd.rol = patch.rol;
  if (patch.activo !== undefined) upd.activo = patch.activo;
  if (patch.cuentas_visibles !== undefined) upd.cuentas_visibles = patch.cuentas_visibles;
  if (patch.cuentas_operables !== undefined) upd.cuentas_operables = patch.cuentas_operables;
  if (patch.rol_id !== undefined) upd.rol_id = patch.rol_id;
  if (patch.apps_permitidas !== undefined) upd.apps_permitidas = patch.apps_permitidas;

  const { error } = await db().from('usuarios').update(upd).eq('id', id);
  return { error: error?.message ?? null };
}

export async function setPermisos(usuarioId: number, slugs: string[]): Promise<{ error: string | null }> {
  // Estrategia "snapshot": borro los actuales y reinserto. Una sola transacción
  // del lado servidor sería ideal — pendiente RPC `fn_set_permisos`.
  const del = await db().from('usuario_permisos').delete().eq('usuario_id', usuarioId);
  if (del.error) return { error: del.error.message };
  if (slugs.length === 0) return { error: null };
  const rows = slugs.map((p) => ({ usuario_id: usuarioId, permiso: p }));
  const { error } = await db().from('usuario_permisos').insert(rows);
  return { error: error?.message ?? null };
}

export async function setLocales(usuarioId: number, localIds: number[]): Promise<{ error: string | null }> {
  const del = await db().from('usuario_locales').delete().eq('usuario_id', usuarioId);
  if (del.error) return { error: del.error.message };
  if (localIds.length === 0) return { error: null };
  const rows = localIds.map((local_id) => ({ usuario_id: usuarioId, local_id }));
  const { error } = await db().from('usuario_locales').insert(rows);
  return { error: error?.message ?? null };
}

export async function resetPassword(usuarioId: number): Promise<{ error: string | null; tempPassword?: string }> {
  // RPC `fn_reset_password_usuario` (genera password temporal y marca
  // password_temporal=true). Si no existe, devuelve error claro.
  const { data, error } = await db().rpc('fn_reset_password_usuario', { p_usuario_id: usuarioId });
  if (error) {
    if (/function .* does not exist/i.test(error.message)) {
      return { error: 'El reset de password necesita la RPC fn_reset_password_usuario. Pasalo a Lucas.' };
    }
    return { error: error.message };
  }
  return { error: null, tempPassword: data as string };
}

export async function listLocales(): Promise<{ data: { id: number; nombre: string }[]; error: string | null }> {
  const { data, error } = await db().from('locales').select('id, nombre').is('deleted_at', null).order('nombre');
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as { id: number; nombre: string }[], error: null };
}
