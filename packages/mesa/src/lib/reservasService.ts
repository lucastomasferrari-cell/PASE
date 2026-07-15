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
  mesas_ids: number[] | null;
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

// ─── Traducción de códigos de error RPC a español legible ─────────────
// Las RPCs hacen RAISE EXCEPTION 'CODIGO_UPPER_SNAKE'; PostgREST devuelve ese
// texto en error.message. Lo mapeamos a un mensaje amable para el toast del admin.
const ERR_RESERVAS: Array<[string, string]> = [
  ['NO_AUTH', 'Tu sesión expiró. Volvé a iniciar sesión.'],
  ['PERMISO_DENEGADO', 'No tenés permiso para esta acción.'],
  ['RESERVA_NO_ENCONTRADA', 'No se encontró la reserva.'],
  ['RESERVA_NO_EDITABLE', 'Esta reserva ya no se puede editar (está finalizada o cancelada).'],
  ['RESERVA_TRANSICION_INVALIDA', 'No se puede cambiar a ese estado desde el actual.'],
  ['RESERVA_NO_ASIGNABLE', 'No se puede asignar mesa a esta reserva en su estado actual.'],
  ['ESTADO_INVALIDO', 'Estado de reserva inválido.'],
  ['MESA_SOLO_AL_SENTAR', 'La mesa solo se asigna al sentar a la reserva.'],
  ['MESA_NO_ENCONTRADA', 'No se encontró la mesa.'],
  ['MESA_OTRO_LOCAL', 'Esa mesa pertenece a otro local.'],
  ['MESA_OCUPADA', 'Esa mesa ya está ocupada en ese horario.'],
  ['MESA_SIN_CAPACIDAD', 'La mesa es chica para esa cantidad de personas. Elegí una más grande o combiná varias.'],
  ['MESA_IDS_REQUERIDAS', 'Elegí al menos una mesa.'],
  ['SIN_MESA', 'No hay ninguna mesa (ni combinación) libre que alcance para esa cantidad en ese horario.'],
  ['NOMBRE_REQUERIDO', 'Falta el nombre del cliente.'],
  ['PERSONAS_INVALIDAS', 'La cantidad de personas es inválida (1 a 50).'],
  ['FECHA_REQUERIDA', 'Falta la fecha y hora.'],
  ['FECHA_PASADA', 'Esa fecha y hora ya pasó.'],
  ['LOCAL_NO_ENCONTRADO', 'No se encontró el local.'],
];
function traducirError(msg?: string | null): string {
  if (!msg) return 'Ocurrió un error.';
  for (const [code, es] of ERR_RESERVAS) if (msg.includes(code)) return es;
  return msg;
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
  if (error) return { id: null, error: traducirError(error.message) };
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
  if (error) return { error: traducirError(error.message) };
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
  if (error) return { error: traducirError(error.message) };
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
  if (error) return { error: traducirError(error.message) };
  return { error: null };
}

// Asignar una COMBINACIÓN de mesas a mano (ej. 2 banquetas contiguas para 2p).
// Valida server-side: capacidad total suficiente, todas libres, del mismo local.
export async function asignarMesasReserva(args: {
  reservaId: number;
  mesaIds: number[];
}): Promise<{ error: string | null }> {
  const { error } = await db().rpc('fn_asignar_mesas_reserva', {
    p_reserva_id: args.reservaId,
    p_mesa_ids: args.mesaIds,
  });
  if (error) return { error: traducirError(error.message) };
  return { error: null };
}

// Auto-asignar: el motor elige (y combina si hace falta) la mejor mesa/tramo
// libre — mismo criterio que la reserva pública. Devuelve las mesas asignadas.
export async function autoAsignarMesaReserva(args: {
  reservaId: number;
}): Promise<{ mesaIds: number[] | null; error: string | null }> {
  const { data, error } = await db().rpc('fn_autoasignar_mesa_reserva', {
    p_reserva_id: args.reservaId,
  });
  if (error) return { mesaIds: null, error: traducirError(error.message) };
  return { mesaIds: (data as number[] | null) ?? [], error: null };
}

// "De paso" / walk-in: cliente que llega sin reserva y se sienta al instante.
// Crea la reserva con hora = ahora y la marca sentada (opcionalmente con mesa).
export async function sentarDePaso(args: {
  localId: number;
  clienteNombre: string;
  personas: number;
  mesaId?: number;
  notas?: string;
}): Promise<{ error: string | null }> {
  const { id, error } = await crearReserva({
    localId: args.localId,
    clienteNombre: args.clienteNombre,
    fechaHora: new Date().toISOString(),
    personas: args.personas,
    notas: args.notas,
    idempotencyKey: `depaso-${args.localId}-${args.clienteNombre}-${Date.now()}`,
  });
  if (error || !id) return { error: error ?? 'No se pudo crear el walk-in' };
  const { error: e2 } = await cambiarEstadoReserva({ reservaId: id, nuevoEstado: 'sentada', mesaId: args.mesaId });
  return { error: e2 };
}

// Reservas confirmadas de hoy todavía sin recordatorio enviado (para la
// sección Recordatorios). Trae las de las próximas `horas` horas.
export async function listReservasParaRecordatorio(
  localId: number,
  horas = 4,
): Promise<{ data: Reserva[]; error: string | null }> {
  const ahora = new Date().toISOString();
  const limite = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();
  const { data, error } = await db()
    .from('reservas')
    .select('*')
    .eq('local_id', localId)
    .eq('estado', 'confirmada')
    .is('deleted_at', null)
    .gte('fecha_hora', ahora)
    .lte('fecha_hora', limite)
    .order('fecha_hora', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Reserva[], error: null };
}

export async function marcarRecordatorioEnviado(reservaId: number): Promise<{ error: string | null }> {
  const { error } = await db()
    .from('reservas')
    .update({ recordatorio_enviado_at: new Date().toISOString() })
    .eq('id', reservaId);
  return { error: error?.message ?? null };
}

// Historial de reservas de un cliente (todas sus visitas, cross-local del tenant).
export async function listReservasByCliente(clienteId: number): Promise<{ data: Reserva[]; error: string | null }> {
  const { data, error } = await db()
    .from('reservas')
    .select('*')
    .eq('cliente_id', clienteId)
    .is('deleted_at', null)
    .order('fecha_hora', { ascending: false })
    .limit(30);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Reserva[], error: null };
}
