// usuariosService — gestión de usuarios del tenant (porteado de PASE).
// Tabla `usuarios` (perfil) + `usuario_permisos` (permisos por slug) +
// `usuario_locales` (locales asignados). La columna `apps_permitidas`
// (migración 202606250700) controla a qué apps del ecosistema entra.
//
// Alta y reset de password van por /api/auth-admin (endpoint en PASE,
// reescrito por vercel.json a pase-yndx). Requiere JWT del caller con
// rol dueno/admin/superadmin.

import { db } from './supabase';
import { esLocalVisible } from './locales';

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await db().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export interface Usuario {
  id: number;
  email: string;
  nombre: string;
  rol: string;                 // dueno / admin / encargado / cajero / compras / etc
  activo: boolean;
  password_temporal: boolean;
  cuentas_visibles: string[] | null;
  cuentas_operables?: string[] | null;
  rol_id?: string | null;       // FK (UUID) a tabla roles (RBAC)
  apps_permitidas?: string[];   // 'pase' | 'comanda' | 'mesa' | 'habitue' | 'accesos'
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
    db().from('usuario_permisos').select('usuario_id, modulo_slug'),
    db().from('usuario_locales').select('usuario_id, local_id'),
  ]);
  if (u.error) return { data: [], error: u.error.message };

  const permByUser = new Map<number, string[]>();
  for (const r of (perms.data ?? []) as { usuario_id: number; modulo_slug: string }[]) {
    const arr = permByUser.get(r.usuario_id) ?? [];
    arr.push(r.modulo_slug);
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
  rol_id?: string | null;
}

// Crea usuario en Auth + perfil en `usuarios`. Va por /api/auth-admin que
// usa service_role para crear el user en Supabase Auth y linkear el perfil.
export async function crearUsuario(input: UsuarioInput): Promise<{ id: number | null; error: string | null }> {
  const headers = await authHeaders();
  if (!headers) return { id: null, error: 'Tu sesión venció. Recargá y volvé a intentar.' };
  try {
    const r = await fetch('/api/auth-admin', {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'create',
        nombre: input.nombre.trim(),
        usuario: input.email.trim(),
        password: input.password,
        rol: input.rol,
        apps_permitidas: input.apps_permitidas ?? ['pase'],
        cuentas_visibles: input.cuentas_visibles ?? null,
        rol_id: input.rol_id ?? null,
      }),
    });
    const d = await r.json();
    if (!d.ok) return { id: null, error: d.error || 'Error creando usuario' };
    return { id: d.id != null ? Number(d.id) : null, error: null };
  } catch (e) {
    return { id: null, error: 'Error de red: ' + (e instanceof Error ? e.message : String(e)) };
  }
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

// Guardado atómico de rol + permisos + locales + cuentas + rol_id, por el
// MISMO RPC que usa PASE (Usuarios.tsx). Reemplaza los inserts sueltos viejos
// (que escribían la columna equivocada `permiso` en vez de `modulo_slug`, no
// seteaban `tenant_id` y no eran atómicos → podían dejar al user en 0 permisos
// si el insert fallaba a mitad). Si algo falla, ROLLBACK: el user queda igual.
export async function sincronizarUsuario(p: {
  usuarioId: number;
  rol: string;
  rolId: string | null;
  modulos: string[];
  locales: number[];
  cuentasVisibles: string[] | null;
  cuentasOperables: string[] | null;
  cuentasAll: boolean;
  activo?: boolean | null;
}): Promise<{ error: string | null }> {
  const { error } = await db().rpc('sincronizar_permisos_usuario', {
    p_usuario_id: p.usuarioId,
    p_rol: p.rol,
    p_modulos: p.modulos,
    p_locales: p.locales,
    p_cuentas_visibles: p.cuentasVisibles,
    p_cuentas_operables: p.cuentasOperables,
    p_cuentas_all: p.cuentasAll,
    p_rol_id: p.rolId,
    p_activo: p.activo ?? null,
  });
  return { error: error?.message ?? null };
}

export async function resetPassword(usuarioId: number): Promise<{ error: string | null; tempPassword?: string }> {
  // Genera password temporal en Supabase Auth y marca password_temporal=true.
  // Va por /api/auth-admin?action=reset_password (PASE).
  const headers = await authHeaders();
  if (!headers) return { error: 'Tu sesión venció. Recargá y volvé a intentar.' };
  try {
    const r = await fetch('/api/auth-admin', {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'reset_password', usuario_id: usuarioId }),
    });
    const d = await r.json();
    if (!d.ok) return { error: d.error || 'Error reseteando contraseña' };
    return { error: null, tempPassword: d.temp_password as string };
  } catch (e) {
    return { error: 'Error de red: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

export async function listLocales(): Promise<{ data: { id: number; nombre: string }[]; error: string | null }> {
  const { data, error } = await db().from('locales').select('id, nombre').order('nombre');
  if (error) return { data: [], error: error.message };
  return { data: ((data ?? []) as { id: number; nombre: string }[]).filter((l) => esLocalVisible(l.nombre)), error: null };
}
