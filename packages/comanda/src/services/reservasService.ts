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
//   - cambiarEstado           → confirmar / cumplida / no_show / cancelada

import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

// ─── Types ────────────────────────────────────────────────────────────

export type EstadoReserva = 'pendiente' | 'confirmada' | 'cumplida' | 'no_show' | 'cancelada';

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
  cumplida_at: string | null;
  cancelada_at: string | null;
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

export async function cambiarEstadoReserva(args: {
  reservaId: number;
  nuevoEstado: 'confirmada' | 'cumplida' | 'no_show' | 'cancelada';
  motivo?: string;
}): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_cambiar_estado_reserva', {
    p_reserva_id: args.reservaId,
    p_nuevo_estado: args.nuevoEstado,
    p_motivo: args.motivo ?? null,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}
