// Queries y mutaciones sobre tickets_soporte. RLS server-side ya filtra
// a "todos los tenants" cuando el caller es superadmin → acá no agregamos
// scope manual.

import { db } from './supabase';

export type EstadoTicket = 'abierto' | 'respondido' | 'cerrado' | 'duplicado';
export type PrioridadTicket = 'baja' | 'media' | 'alta' | 'critica';
export type CategoriaTicket = 'duda' | 'bug' | 'feature' | 'otro';
export type SistemaOrigen = 'comanda' | 'pase';

export interface TicketComentario {
  autor_user_id: number | null;
  autor_rol: string | null;
  texto: string;
  created_at: string;
}

export type AgentStatus = 'pending' | 'investigating' | 'escalating' | 'fixing' | 'pr_opened' | 'resolved' | 'failed';

export interface AgentLogEntry {
  event: string;
  ts?: string;
  [k: string]: unknown;
}

export interface Ticket {
  id: string;
  tenant_id: string;
  autor_user_id: number | null;
  autor_email: string | null;
  autor_rol: string | null;
  sistema: SistemaOrigen;
  pantalla_origen: string | null;
  mensaje: string;
  categoria: CategoriaTicket | null;
  prioridad: PrioridadTicket | null;
  screenshot_url: string | null;
  contexto_jsonb: Record<string, unknown>;
  respuesta_llm: string | null;
  estado: EstadoTicket;
  comentarios: TicketComentario[];
  atendido_por: number | null;
  atendido_at: string | null;
  resuelto_at: string | null;
  created_at: string;
  updated_at: string;
  // Auto-fix agent (migration 202605201500).
  agent_status: AgentStatus | null;
  agent_pr_url: string | null;
  agent_pr_number: number | null;
  agent_started_at: string | null;
  agent_finished_at: string | null;
  agent_model_used: string | null;
  agent_cost_usd: number | null;
  agent_log: AgentLogEntry[];
  agent_diff_summary: string | null;
}

export interface ListFilters {
  estado?: EstadoTicket | 'todos';
  sistema?: SistemaOrigen | 'todos';
  prioridad?: PrioridadTicket | 'todos';
  /** Cuando 'pr_opened', filtra agent_status. Útil para vista "PRs pendientes". */
  agentStatus?: AgentStatus | 'todos';
}

export async function listTickets(filters: ListFilters = {}): Promise<{ data: Ticket[]; error: string | null }> {
  let q = db.from('tickets_soporte').select('*').order('created_at', { ascending: false }).limit(200);
  if (filters.estado && filters.estado !== 'todos') q = q.eq('estado', filters.estado);
  if (filters.sistema && filters.sistema !== 'todos') q = q.eq('sistema', filters.sistema);
  if (filters.prioridad && filters.prioridad !== 'todos') q = q.eq('prioridad', filters.prioridad);
  if (filters.agentStatus && filters.agentStatus !== 'todos') q = q.eq('agent_status', filters.agentStatus);
  const { data, error } = await q;
  return { data: (data as Ticket[]) ?? [], error: error?.message ?? null };
}

// Marca un ticket como resuelto. Lo usa el superadmin cuando aprueba+mergeó
// un PR auto-generado desde GitHub directamente. Setea estado='cerrado' y
// agent_status='resolved' para sacar el ticket de las colas activas.
export async function marcarResuelto(ticketId: string): Promise<{ error: string | null }> {
  const { error } = await db.from('tickets_soporte').update({
    estado: 'cerrado',
    resuelto_at: new Date().toISOString(),
    agent_status: 'resolved',
  }).eq('id', ticketId);
  return { error: error?.message ?? null };
}

export async function getTicket(id: string): Promise<{ data: Ticket | null; error: string | null }> {
  const { data, error } = await db.from('tickets_soporte').select('*').eq('id', id).single();
  return { data: (data as Ticket) ?? null, error: error?.message ?? null };
}

export async function agregarComentario(ticketId: string, texto: string): Promise<{ error: string | null }> {
  const { error } = await db.rpc('agregar_comentario_ticket', {
    p_ticket_id: ticketId,
    p_texto: texto,
  });
  return { error: error?.message ?? null };
}

export async function cerrarTicket(ticketId: string, motivo?: string): Promise<{ error: string | null }> {
  const { error } = await db.rpc('cerrar_ticket', {
    p_ticket_id: ticketId,
    p_motivo: motivo ?? null,
  });
  return { error: error?.message ?? null };
}

// Marca un ticket como "respondido" (estado), útil para que aparezca arriba
// del filtro "respondidos" cuando el superadmin ya lo contestó. La RPC
// agregar_comentario_ticket lo hace automático cuando un superadmin postea
// el primer comentario.
export async function reabrirTicket(ticketId: string): Promise<{ error: string | null }> {
  // Solo superadmin via RLS UPDATE policy.
  const { error } = await db
    .from('tickets_soporte')
    .update({ estado: 'abierto', resuelto_at: null })
    .eq('id', ticketId);
  return { error: error?.message ?? null };
}

export async function setPrioridad(ticketId: string, prioridad: PrioridadTicket): Promise<{ error: string | null }> {
  const { error } = await db.from('tickets_soporte').update({ prioridad }).eq('id', ticketId);
  return { error: error?.message ?? null };
}

// Signed URL para descargar screenshot del bucket privado.
export async function getScreenshotUrl(path: string): Promise<string | null> {
  const { data, error } = await db.storage
    .from('soporte-screenshots')
    .createSignedUrl(path, 60 * 5); // 5 min
  if (error || !data) return null;
  return data.signedUrl;
}
