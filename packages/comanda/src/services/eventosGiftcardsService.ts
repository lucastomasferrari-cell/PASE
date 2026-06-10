// eventosGiftcardsService — MESA módulo #4 fase 2 (09-jun).
//
// Catálogos (eventos / giftcards): CRUD directo bajo RLS (staff del tenant).
// Plata (inscripciones / compras): SOLO LECTURA acá — las escribe la RPC
// pública (pendiente_pago) y el webhook MP (pagada). El canje va por RPC.
// Migración backend: 202606100600_mesa_modulo4_eventos_giftcards.sql.

import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

// ─── Tipos ─────────────────────────────────────────────────────────────────

export type EstadoEvento = 'borrador' | 'publicado' | 'agotado' | 'finalizado' | 'cancelado';

export interface Evento {
  id: number;
  local_id: number;
  titulo: string;
  descripcion: string | null;
  foto_url: string | null;
  fecha_inicio: string;
  fecha_fin: string | null;
  precio_por_persona: number;
  cupos_total: number;
  cupos_vendidos: number;
  estado: EstadoEvento;
}

export interface EventoInscripcion {
  id: number;
  evento_id: number;
  nombre: string;
  telefono: string | null;
  email: string | null;
  cantidad: number;
  monto_total: number;
  estado: 'pendiente_pago' | 'pagada' | 'cancelada' | 'reembolsada';
  pagada_at: string | null;
  created_at: string;
}

export interface Giftcard {
  id: number;
  local_id: number | null;   // null = todo el grupo
  nombre: string;
  descripcion: string | null;
  foto_url: string | null;
  precio: number;
  activa: boolean;
}

export interface GiftcardCompra {
  id: number;
  giftcard_id: number;
  comprador_nombre: string;
  comprador_email: string | null;
  para_nombre: string | null;
  codigo: string | null;
  monto: number;
  estado: 'pendiente_pago' | 'pagada' | 'canjeada' | 'cancelada';
  pagada_at: string | null;
  canjeada_at: string | null;
  created_at: string;
}

// ─── Eventos ───────────────────────────────────────────────────────────────

export async function listEventos(localId: number): Promise<{ data: Evento[]; error: string | null }> {
  const { data, error } = await db.from('eventos')
    .select('id, local_id, titulo, descripcion, foto_url, fecha_inicio, fecha_fin, precio_por_persona, cupos_total, cupos_vendidos, estado')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('fecha_inicio', { ascending: false })
    .limit(100);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Evento[], error: null };
}

export interface EventoInput {
  titulo: string;
  descripcion?: string;
  fotoUrl?: string;
  fechaInicio: string;       // ISO
  fechaFin?: string | null;
  precioPorPersona: number;
  cuposTotal: number;
}

export async function crearEvento(localId: number, tenantId: string, input: EventoInput): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('eventos').insert({
    tenant_id: tenantId,
    local_id: localId,
    titulo: input.titulo,
    descripcion: input.descripcion || null,
    foto_url: input.fotoUrl || null,
    fecha_inicio: input.fechaInicio,
    fecha_fin: input.fechaFin ?? null,
    precio_por_persona: input.precioPorPersona,
    cupos_total: input.cuposTotal,
    estado: 'borrador',
  }).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: (data as { id: number }).id, error: null };
}

export async function actualizarEvento(id: number, input: Partial<EventoInput>): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.titulo !== undefined) patch.titulo = input.titulo;
  if (input.descripcion !== undefined) patch.descripcion = input.descripcion || null;
  if (input.fotoUrl !== undefined) patch.foto_url = input.fotoUrl || null;
  if (input.fechaInicio !== undefined) patch.fecha_inicio = input.fechaInicio;
  if (input.fechaFin !== undefined) patch.fecha_fin = input.fechaFin;
  if (input.precioPorPersona !== undefined) patch.precio_por_persona = input.precioPorPersona;
  if (input.cuposTotal !== undefined) patch.cupos_total = input.cuposTotal;
  const { error } = await db.from('eventos').update(patch).eq('id', id);
  return { error: error ? translateError(error) : null };
}

// borrador→publicado, publicado→cancelado/finalizado, etc. Validación simple
// acá (catálogo, no plata): no permitir volver a publicar uno cancelado con vendidos.
export async function cambiarEstadoEvento(id: number, estado: EstadoEvento): Promise<{ error: string | null }> {
  const { error } = await db.from('eventos')
    .update({ estado, updated_at: new Date().toISOString() }).eq('id', id);
  return { error: error ? translateError(error) : null };
}

export async function eliminarEvento(id: number): Promise<{ error: string | null }> {
  // Soft delete. Solo tiene sentido para borradores sin inscripciones — la UI
  // lo restringe; las filas de plata quedan intactas igual.
  const { error } = await db.from('eventos')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error ? translateError(error) : null };
}

export async function listInscripciones(eventoId: number): Promise<{ data: EventoInscripcion[]; error: string | null }> {
   
  const { data, error } = await db.from('evento_inscripciones')
    .select('id, evento_id, nombre, telefono, email, cantidad, monto_total, estado, pagada_at, created_at')
    .eq('evento_id', eventoId)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as EventoInscripcion[], error: null };
}

// ─── Giftcards ─────────────────────────────────────────────────────────────

export async function listGiftcards(localId: number): Promise<{ data: Giftcard[]; error: string | null }> {
  // Las del local + las del grupo (local_id NULL).
   
  const { data, error } = await db.from('giftcards')
    .select('id, local_id, nombre, descripcion, foto_url, precio, activa')
    .or(`local_id.eq.${localId},local_id.is.null`)
    .is('deleted_at', null)
    .order('precio');
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Giftcard[], error: null };
}

export interface GiftcardInput {
  nombre: string;
  descripcion?: string;
  fotoUrl?: string;
  precio: number;
  todoElGrupo: boolean;
}

export async function crearGiftcard(localId: number, tenantId: string, input: GiftcardInput): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('giftcards').insert({
    tenant_id: tenantId,
    local_id: input.todoElGrupo ? null : localId,
    nombre: input.nombre,
    descripcion: input.descripcion || null,
    foto_url: input.fotoUrl || null,
    precio: input.precio,
    activa: true,
  }).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: (data as { id: number }).id, error: null };
}

export async function actualizarGiftcard(id: number, input: Partial<GiftcardInput> & { activa?: boolean }): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.nombre !== undefined) patch.nombre = input.nombre;
  if (input.descripcion !== undefined) patch.descripcion = input.descripcion || null;
  if (input.fotoUrl !== undefined) patch.foto_url = input.fotoUrl || null;
  if (input.precio !== undefined) patch.precio = input.precio;
  if (input.activa !== undefined) patch.activa = input.activa;
  const { error } = await db.from('giftcards').update(patch).eq('id', id);
  return { error: error ? translateError(error) : null };
}

export async function listComprasGiftcards(localId: number): Promise<{ data: (GiftcardCompra & { giftcards: { nombre: string } | null })[]; error: string | null }> {
  const { data, error } = await db.from('giftcard_compras')
    .select('id, giftcard_id, comprador_nombre, comprador_email, para_nombre, codigo, monto, estado, pagada_at, canjeada_at, created_at, giftcards(nombre)')
    .eq('local_id', localId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as never, error: null };
}

export interface CanjeResultado {
  ok: boolean;
  giftcard: string;
  monto: number;
  comprador: string;
  para: string | null;
  mensaje: string | null;
}

export async function canjearGiftcard(codigo: string, ventaId?: number): Promise<{ data: CanjeResultado | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_canjear_giftcard', {
    p_codigo: codigo,
    p_venta_id: ventaId ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  return { data: data as CanjeResultado, error: null };
}
