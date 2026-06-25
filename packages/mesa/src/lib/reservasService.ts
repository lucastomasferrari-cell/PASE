// reservasService — gestión de reservas para el panel admin de MESA.
// Portado de COMANDA (packages/comanda/src/services/reservasService.ts):
// misma base Supabase + mismas RPCs (fn_crear_reserva / fn_editar_reserva /
// fn_cambiar_estado_reserva / fn_asignar_mesa_reserva), validadas server-side
// por local visible del usuario autenticado. Acá usamos el cliente db() de MESA
// (sesión real del dueño/encargado, RLS por tenant + local).

import { db } from './supabase';

// ─── Types ────────────────────────────────────────────────────────────
export type EstadoReserva =
  | 'pendiente' | 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada';

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
  duracion_min: number | null;
  no_show_auto: boolean;
  recordatorio_enviado_at: string | null;
  cliente_id: number | null;
}

export interface MesaSimple {
  id: number;
  numero: string | number;
  zona: string | null;
  capacidad: number | null;
}

export interface ListReservasOpts {
  localId?: number;
  estado?: EstadoReserva | 'todas';
  desde?: string;
  hasta?: string;
  limit?: number;
}

// ─── Lectura ──────────────────────────────────────────────────────────
export async function listReservas(opts: ListReservasOpts = {}): Promise<{ data: Reserva[]; error: string | null }> {
  let q = db().from('reservas').select('*').is('deleted_at', null);
  if (opts.localId) q = q.eq('local_id', opts.localId);
  if (opts.estado && opts.estado !== 'todas') q = q.eq('estado', opts.estado);
  if (opts.desde) q = q.gte('fecha_hora', opts.desde);
  if (opts.hasta) q = q.lte('fecha_hora', opts.hasta);
  q = q.order('fecha_hora', { ascending: true }).limit(opts.limit ?? 200);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Reserva[], error: null };
}

export async function listMesasDelLocal(localId: number): Promise<{ data: MesaSimple[]; error: string | null }> {
  const { data, error } = await db().from('mesas')
    .select('id, numero, zona, capacidad')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('zona', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as MesaSimple[], error: null };
}

// ─── Escritura (RPCs atómicas con validación server-side) ─────────────
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
  const { data, error } = await db().rpc('fn_crear_reserva', {
    p_local_id: args.localId,
    p_cliente_nombre: args.clienteNombre,
    p_cliente_telefono: args.clienteTelefono ?? null,
    p_cliente_email: args.clienteEmail ?? null,
    p_fecha_hora: args.fechaHora,
    p_personas: args.personas,
    p_notas: args.notas ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) return { id: null, error: error.message };
  return { id: Number(data), error: null };
}

// Los campos undefined NO se tocan (la RPC usa COALESCE por campo).
// El backend solo permite editar en estado pendiente/confirmada.
export async function editarReserva(args: {
  reservaId: number;
  clienteNombre?: string;
  clienteTelefono?: string;
  clienteEmail?: string;
  fechaHora?: string;
  personas?: number;
  notas?: string;
}): Promise<{ error: string | null }> {
  const { error } = await db().rpc('fn_editar_reserva', {
    p_reserva_id: args.reservaId,
    p_cliente_nombre: args.clienteNombre ?? null,
    p_cliente_telefono: args.clienteTelefono ?? null,
    p_cliente_email: args.clienteEmail ?? null,
    p_fecha_hora: args.fechaHora ?? null,
    p_personas: args.personas ?? null,
    p_notas: args.notas ?? null,
  });
  if (error) return { error: error.message };
  return { error: null };
}

export async function cambiarEstadoReserva(args: {
  reservaId: number;
  nuevoEstado: 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada';
  motivo?: string;
  mesaId?: number;
}): Promise<{ error: string | null }> {
  const { error } = await db().rpc('fn_cambiar_estado_reserva', {
    p_reserva_id: args.reservaId,
    p_nuevo_estado: args.nuevoEstado,
    p_motivo: args.motivo ?? null,
    p_mesa_id: args.mesaId ?? null,
  });
  if (error) return { error: error.message };
  return { error: null };
}

export async function asignarMesaReserva(args: {
  reservaId: number;
  mesaId: number;
}): Promise<{ error: string | null }> {
  const { error } = await db().rpc('fn_asignar_mesa_reserva', {
    p_reserva_id: args.reservaId,
    p_mesa_id: args.mesaId,
  });
  if (error) return { error: error.message };
  return { error: null };
}
