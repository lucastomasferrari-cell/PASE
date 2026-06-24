// reservasService — reservas de mesa online.
//
// Para cliente público (sin auth):
//   - getReservasInfoPublico   → config del local
//   - checkDisponibilidad      → ¿hay cupo para fecha + N personas?
//   - crearReservaPublica      → crea reserva
//   - cancelarReservaPublica   → cancela si matchea telefono
//
// Para admin (con auth):
//   - listReservas            → reservas del local con filtros
//   - cambiarEstado           → confirmar / sentar / finalizar / no_show / cancelar

import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

// ─── Types ────────────────────────────────────────────────────────────

// Modelo v3 (12-jun): 'cumplida' ya no existe — el histórico se migró a
// 'finalizada' y al sentar se usa 'sentada' (estado activo, no terminal).
// La reserva sentada se finaliza sola cuando se cobra el ticket linkeado.
export type EstadoReserva = 'pendiente' | 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada';

export interface Reserva {
  id: number;
  tenant_id: string;
  local_id: number;
  cliente_nombre: string;
  cliente_telefono: string | null;
  cliente_email: string | null;
  fecha_hora: string;
  personas: number;
  notas: string | null;
  estado: EstadoReserva;
  motivo_cancelacion: string | null;
  cancelada_por_cliente: boolean;
  mesa_id: number | null;
  created_at: string;
  confirmada_at: string | null;
  cancelada_at: string | null;
  // Modelo v3 (12-jun)
  duracion_min: number | null;
  no_show_auto: boolean;
  // Módulo notificaciones (24-jun)
  recordatorio_enviado_at: string | null;
  // CRM 360° (24-jun)
  cliente_id: number | null;
}

export interface ReservasInfoPublico {
  local_id: number;
  local_nombre: string;
  activas: boolean;
  capacidad_max: number;
  anticipacion_min_hs: number;
  anticipacion_max_dias: number;
  duracion_estimada_min: number;
  horarios: Array<{ dia: number; abre: string; cierra: string }>;
  telefono_obligatorio: boolean;
  notas_publicas: string | null;
  requiere_confirmacion: boolean;
}

// ─── Public (anon) ────────────────────────────────────────────────────

export async function getReservasInfoPublico(slug: string): Promise<{ data: ReservasInfoPublico | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_reservas_info_publico', { p_local_slug: slug });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as ReservasInfoPublico[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

export interface DisponibilidadReserva {
  disponible: boolean;
  motivo: string;
  personas_actuales: number;
  capacidad_max: number;
}

export async function checkDisponibilidadReserva(args: {
  slug: string;
  fechaHora: string; // ISO
  personas: number;
}): Promise<{ data: DisponibilidadReserva | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_check_disponibilidad_reserva', {
    p_local_slug: args.slug,
    p_fecha_hora: args.fechaHora,
    p_personas: args.personas,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as DisponibilidadReserva[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

export async function crearReservaPublica(args: {
  slug: string;
  clienteNombre: string;
  clienteTelefono: string;
  clienteEmail?: string;
  fechaHora: string;
  personas: number;
  notas?: string;
  idempotencyKey?: string;
}): Promise<{ data: { id: number; estado: EstadoReserva } | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_crear_reserva_publica', {
    p_local_slug: args.slug,
    p_cliente_nombre: args.clienteNombre,
    p_cliente_telefono: args.clienteTelefono,
    p_cliente_email: args.clienteEmail ?? null,
    p_fecha_hora: args.fechaHora,
    p_personas: args.personas,
    p_notas: args.notas ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as Array<{ id: number; estado: EstadoReserva }> | null;
  const row = arr?.[0];
  if (!row) return { data: null, error: 'Sin resultado' };
  return { data: row, error: null };
}

export async function cancelarReservaPublica(args: {
  reservaId: number;
  telefono: string;
  motivo?: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_cancelar_reserva_publica', {
    p_reserva_id: args.reservaId,
    p_telefono: args.telefono,
    p_motivo: args.motivo ?? null,
  });
  if (error) return { ok: false, error: translateError(error) };
  return { ok: !!data, error: null };
}

// ─── Admin (auth) ─────────────────────────────────────────────────────

export interface ListReservasOpts {
  localId?: number;
  estado?: EstadoReserva | 'todas';
  desde?: string;
  hasta?: string;
  limit?: number;
}

export async function listReservas(opts: ListReservasOpts = {}): Promise<{ data: Reserva[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS por tenant_id + local
  let q = db.from('reservas').select('*').is('deleted_at', null);
  if (opts.localId) q = q.eq('local_id', opts.localId);
  if (opts.estado && opts.estado !== 'todas') q = q.eq('estado', opts.estado);
  if (opts.desde) q = q.gte('fecha_hora', opts.desde);
  if (opts.hasta) q = q.lte('fecha_hora', opts.hasta);
  q = q.order('fecha_hora', { ascending: true }).limit(opts.limit ?? 200);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Reserva[], error: null };
}

// MESA módulo #1 (09-jun): alta MANUAL por el staff. La creación pública
// (fn_crear_reserva_publica) sigue aparte — esta valida contra el local
// visible del usuario autenticado y es idempotente.
export async function crearReserva(args: {
  localId: number;
  clienteNombre: string;
  clienteTelefono?: string;
  clienteEmail?: string;
  fechaHora: string;          // ISO timestamptz
  personas: number;
  notas?: string;
  idempotencyKey?: string;
}): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_crear_reserva', {
    p_local_id: args.localId,
    p_cliente_nombre: args.clienteNombre,
    p_cliente_telefono: args.clienteTelefono ?? null,
    p_cliente_email: args.clienteEmail ?? null,
    p_fecha_hora: args.fechaHora,
    p_personas: args.personas,
    p_notas: args.notas ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: Number(data), error: null };
}

// MESA módulo #1: edición — el backend solo la permite en pendiente/confirmada.
// Los campos undefined NO se tocan (la RPC usa COALESCE/CASE por campo).
export async function editarReserva(args: {
  reservaId: number;
  clienteNombre?: string;
  clienteTelefono?: string;
  clienteEmail?: string;
  fechaHora?: string;
  personas?: number;
  notas?: string;
}): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_editar_reserva', {
    p_reserva_id: args.reservaId,
    p_cliente_nombre: args.clienteNombre ?? null,
    p_cliente_telefono: args.clienteTelefono ?? null,
    p_cliente_email: args.clienteEmail ?? null,
    p_fecha_hora: args.fechaHora ?? null,
    p_personas: args.personas ?? null,
    p_notas: args.notas ?? null,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function cambiarEstadoReserva(args: {
  reservaId: number;
  nuevoEstado: 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada';
  motivo?: string;
  // MESA módulo #1: al sentar se puede asignar mesa en el mismo paso.
  // El backend valida que la mesa sea del mismo local.
  mesaId?: number;
}): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_cambiar_estado_reserva', {
    p_reserva_id: args.reservaId,
    p_nuevo_estado: args.nuevoEstado,
    p_motivo: args.motivo ?? null,
    p_mesa_id: args.mesaId ?? null,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

// F5 Chunk D (2026-06-02): asignar mesa a reserva. Valida que la mesa
// pertenezca al mismo local que la reserva + que la reserva esté en
// estado pendiente/confirmada (sentada/finalizada/cancelada/no_show no se reasignan acá).
export async function asignarMesaReserva(args: {
  reservaId: number;
  mesaId: number;
}): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_asignar_mesa_reserva', {
    p_reserva_id: args.reservaId,
    p_mesa_id: args.mesaId,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

// Lista de mesas activas del local — para el dropdown de asignación.
export interface MesaSimple {
  id: number;
  numero: string | number;
  zona: string | null;
  capacidad: number | null;
}
export async function listMesasDelLocal(localId: number): Promise<{ data: MesaSimple[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- filtro explícito por local_id
  const { data, error } = await db.from('mesas')
    .select('id, numero, zona, capacidad')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('zona', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MesaSimple[], error: null };
}

// ─── Recordatorios ────────────────────────────────────────────────────────────

export async function listReservasParaRecordatorio(
  localId: number,
): Promise<{ data: Reserva[]; error: string | null }> {
  const ahora = new Date().toISOString();
  const en2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  // eslint-disable-next-line pase-local/require-apply-local-scope -- filtro explícito local_id
  const { data, error } = await db
    .from('reservas')
    .select('*')
    .eq('local_id', localId)
    .eq('estado', 'confirmada')
    .is('deleted_at', null)
    .is('recordatorio_enviado_at', null)
    .gte('fecha_hora', ahora)
    .lte('fecha_hora', en2h)
    .order('fecha_hora', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Reserva[], error: null };
}

// CRM 360°: historial de reservas por cliente (todas sus visitas, cross-local)
export async function listReservasByCliente(
  clienteId: number,
): Promise<{ data: Reserva[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- cross-local intencional: el cliente puede haber reservado en varios locales del tenant
  const { data, error } = await db
    .from('reservas')
    .select('*')
    .eq('cliente_id', clienteId)
    .is('deleted_at', null)
    .order('fecha_hora', { ascending: false })
    .limit(30);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Reserva[], error: null };
}

export async function marcarRecordatorioEnviado(reservaId: number): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS por tenant_id
  const { error } = await db
    .from('reservas')
    .update({ recordatorio_enviado_at: new Date().toISOString() })
    .eq('id', reservaId);
  return { error: error?.message ?? null };
}
