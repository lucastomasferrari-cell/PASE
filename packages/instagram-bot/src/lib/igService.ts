// igService — datos del bot de Instagram. Lee/escribe las tablas ig_* del mismo
// Supabase. Los mensajes manuales salen por el endpoint /api/send de este mismo
// proyecto (same-origin). Override opcional con VITE_IG_BOT_URL.
//
// OJO nombres de columnas REALES (la versión de Habitué tenía varios mal, nunca
// se probó en vivo): ig_config usa `bot_activo` (no `activo`); `mensajes_count`
// vive en ig_clientes (no en ig_conversaciones); ig_mensajes usa `created_at`
// (no `enviado_at`) e `ig_mid` (no `meta_message_id`).

import { db } from './supabase';

// Vacío = same-origin (la web vive en el mismo deploy que /api/send).
export const BOT_API_URL =
  (import.meta.env.VITE_IG_BOT_URL as string | undefined) || '';

export type EstadoConversacion = 'bot' | 'humano' | 'escalada' | 'cerrada' | 'spam';

export interface CuentaIG {
  id: number;
  ig_username: string | null;
  local_id: number | null;
}

export interface Conversacion {
  id: number;
  ig_config_id: number | null;
  estado: EstadoConversacion;
  tomada_por: number | null;
  tomada_at: string | null;
  ultimo_mensaje_at: string;
  ultimo_mensaje_preview: string | null;
  no_leidos_admin: number;
  created_at: string;
  cliente_id: number;
  igsid: string;
  ig_username: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  mensajes_count: number;
  bloqueado: boolean;
}

export interface Mensaje {
  id: number;
  conversacion_id: number;
  direccion: 'in' | 'out';
  origen: 'cliente' | 'bot' | 'humano';
  usuario_id: number | null;
  texto: string;
  enviado_at: string;
  meta_message_id: string | null;
}

export interface IGConfig {
  id: number;
  ig_username: string | null;
  activo: boolean;
  system_prompt: string | null;
  max_tokens: number | null;
  rate_limit_msgs: number | null;
  rate_limit_minutos: number | null;
  modelo: string | null;
}

// ─── Cuentas IG (chips arriba) ──────────────────────────────────────────────
// Sin filtro de estado: mostramos todas las cuentas del tenant (RLS ya scopea).
// No filtramos por bot_activo para no esconder una cuenta con el bot en pausa.
export async function listCuentas(): Promise<{ data: CuentaIG[]; error: string | null }> {
  const { data, error } = await db()
    .from('ig_config')
    .select('id, ig_username, local_id')
    .order('id');
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as CuentaIG[], error: null };
}

// ─── Conversaciones ─────────────────────────────────────────────────────────
export async function listConversaciones(opts: {
  cuentaId?: number;
  estado?: EstadoConversacion | 'todas';
  limit?: number;
} = {}): Promise<{ data: Conversacion[]; error: string | null }> {
  let q = db()
    .from('ig_conversaciones')
    .select(`
      id, ig_config_id, estado, tomada_por, tomada_at,
      ultimo_mensaje_at, ultimo_mensaje_preview, no_leidos_admin,
      created_at, cliente_id,
      ig_clientes!inner(igsid, nombre, telefono, bloqueado, mensajes_count, ig_username)
    `)
    .order('ultimo_mensaje_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.cuentaId) q = q.eq('ig_config_id', opts.cuentaId);
  if (opts.estado && opts.estado !== 'todas') q = q.eq('estado', opts.estado);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  const rows = (data ?? []).map((r) => {
    const row = r as unknown as {
      id: number; ig_config_id: number | null; estado: EstadoConversacion;
      tomada_por: number | null; tomada_at: string | null;
      ultimo_mensaje_at: string; ultimo_mensaje_preview: string | null;
      no_leidos_admin: number; created_at: string; cliente_id: number;
      ig_clientes: { igsid: string; nombre: string | null; telefono: string | null; bloqueado: boolean; mensajes_count: number; ig_username: string | null };
    };
    return {
      id: row.id, ig_config_id: row.ig_config_id, estado: row.estado,
      tomada_por: row.tomada_por, tomada_at: row.tomada_at,
      ultimo_mensaje_at: row.ultimo_mensaje_at,
      ultimo_mensaje_preview: row.ultimo_mensaje_preview,
      no_leidos_admin: row.no_leidos_admin,
      created_at: row.created_at, cliente_id: row.cliente_id,
      mensajes_count: row.ig_clientes.mensajes_count,
      igsid: row.ig_clientes.igsid,
      ig_username: row.ig_clientes.ig_username,
      cliente_nombre: row.ig_clientes.nombre,
      cliente_telefono: row.ig_clientes.telefono,
      bloqueado: row.ig_clientes.bloqueado,
    } satisfies Conversacion;
  });
  return { data: rows, error: null };
}

// ─── Mensajes del thread ────────────────────────────────────────────────────
// La tabla usa created_at + ig_mid; los aliaseamos al shape que espera la UI.
export async function listMensajes(conversacionId: number, limit = 100): Promise<{ data: Mensaje[]; error: string | null }> {
  const { data, error } = await db()
    .from('ig_mensajes')
    .select('id, conversacion_id, direccion, origen, usuario_id, texto, enviado_at:created_at, meta_message_id:ig_mid')
    .eq('conversacion_id', conversacionId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as unknown as Mensaje[], error: null };
}

export async function marcarLeida(conversacionId: number): Promise<{ error: string | null }> {
  const { error } = await db()
    .from('ig_conversaciones')
    .update({ no_leidos_admin: 0 })
    .eq('id', conversacionId);
  return { error: error?.message ?? null };
}

// ─── Cambiar estado (tomar / devolver / cerrar / etc.) ──────────────────────
export async function setEstado(
  conversacionId: number,
  estado: EstadoConversacion,
  tomadaPor: number | null = null,
): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { estado };
  if (estado === 'humano') {
    patch.tomada_por = tomadaPor;
    patch.tomada_at = new Date().toISOString();
  } else if (estado === 'bot') {
    patch.tomada_por = null;
    patch.tomada_at = null;
  }
  const { error } = await db().from('ig_conversaciones').update(patch).eq('id', conversacionId);
  return { error: error?.message ?? null };
}

export async function bloquearCliente(clienteId: number, bloqueado: boolean): Promise<{ error: string | null }> {
  const { error } = await db().from('ig_clientes').update({ bloqueado }).eq('id', clienteId);
  return { error: error?.message ?? null };
}

// ─── Envío manual (humano responde) ─────────────────────────────────────────
export async function enviarMensaje(args: {
  conversacionId: number;
  texto: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: sess } = await db().auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return { ok: false, error: 'Sesión expirada' };
    const r = await fetch(`${BOT_API_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversacion_id: args.conversacionId, texto: args.texto }),
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Config del bot ─────────────────────────────────────────────────────────
// La columna real es bot_activo → la aliaseamos a `activo` para la UI.
export async function getConfig(igConfigId: number): Promise<{ data: IGConfig | null; error: string | null }> {
  const { data, error } = await db()
    .from('ig_config')
    .select('id, ig_username, activo:bot_activo, system_prompt, max_tokens, rate_limit_msgs, rate_limit_minutos, modelo')
    .eq('id', igConfigId)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: (data as unknown as IGConfig | null), error: null };
}

export async function updateConfig(id: number, patch: Partial<IGConfig>): Promise<{ error: string | null }> {
  // Solo dejamos pasar campos editables seguros. `activo` (UI) → `bot_activo` (DB).
  const safe: Record<string, unknown> = {};
  if (patch.activo !== undefined) safe.bot_activo = patch.activo;
  if (patch.system_prompt !== undefined) safe.system_prompt = patch.system_prompt;
  if (patch.max_tokens !== undefined) safe.max_tokens = patch.max_tokens;
  if (patch.rate_limit_msgs !== undefined) safe.rate_limit_msgs = patch.rate_limit_msgs;
  if (patch.rate_limit_minutos !== undefined) safe.rate_limit_minutos = patch.rate_limit_minutos;
  if (patch.modelo !== undefined) safe.modelo = patch.modelo;
  const { error } = await db().from('ig_config').update(safe).eq('id', id);
  return { error: error?.message ?? null };
}
