// printAgentsService — gestión de Print Agents desde el POS.
//
// Cada local puede tener múltiples agents (1 por PC). El dueño crea el token
// en COMANDA, lo copia al instalador del agent, y el agent empieza a mandar
// heartbeat. Esta service expone:
//   - listAgents(localId)              → ver todos con status derivado
//   - crearAgentToken(localId, nombre) → genera token nuevo
//   - revocarAgent(id)                  → soft delete

import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

export interface PrintAgent {
  id: number;
  tenant_id: string;
  local_id: number;
  local_nombre: string | null;
  nombre: string;
  hostname: string | null;
  os_platform: string | null;
  agent_version: string | null;
  last_seen_at: string | null;
  printers_total: number;
  printers_online: number;
  queue_queued: number;
  queue_printing: number;
  queue_failed: number;
  queue_dead_letter: number;
  metadata: {
    printers?: Array<{
      id: string;
      nombre: string;
      estacion: string | null;
      transporte: string;
      online: boolean;
    }>;
  };
  created_at: string;
  /** Calculado server-side en v_print_agents_status. */
  status: 'never' | 'online' | 'stale' | 'offline';
}

export async function listAgents(localId?: number): Promise<{ data: PrintAgent[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- la vista filtra por RLS + auth_locales_visibles
  let q = db.from('v_print_agents_status').select('*');
  if (localId) q = q.eq('local_id', localId);
  q = q.order('last_seen_at', { ascending: false, nullsFirst: false });
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as PrintAgent[], error: null };
}

export async function crearAgentToken(
  localId: number,
  nombre: string,
): Promise<{ data: { id: number; agent_token: string } | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_crear_print_agent_token', {
    p_local_id: localId,
    p_nombre: nombre,
  });
  if (error) return { data: null, error: translateError(error) };
  // Migration 202605203900 renombró el out param a agent_id.
  const arr = data as Array<{ agent_id: number; agent_token: string }> | null;
  const row = arr?.[0];
  if (!row) return { data: null, error: 'Sin resultado' };
  return { data: { id: row.agent_id, agent_token: row.agent_token }, error: null };
}

export async function revocarAgent(id: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_revocar_print_agent', { p_agent_id: id });
  if (error) return { error: translateError(error) };
  return { error: null };
}
