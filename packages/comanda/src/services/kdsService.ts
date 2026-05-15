import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

// KDS — accedido desde tablets sin login. La autorización es vía token de
// estación. Las RPCs son SECURITY DEFINER y validan el token internamente.

export interface KdsTicket {
  item_id: number;
  venta_id: number;
  cantidad: number;
  modificadores: { nombre: string; precio_extra?: number }[] | null;
  curso: number | null;
  estado: 'enviado' | 'listo';
  enviado_at: string;
  notas: string | null;
  estacion: string;
  item_nombre: string;
  item_emoji: string | null;
  venta_numero: number;
  modo: string;
  mesa_numero: string | null;
  mesa_zona: string | null;
  cliente_nombre: string | null;
  mozo_nombre: string;
  segundos_desde_enviado: number;
}

export async function getTickets(token: string): Promise<{ data: KdsTicket[]; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_kds_get_tickets_comanda', { p_token: token });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as KdsTicket[], error: null };
}

export async function marcarListo(token: string, itemId: number): Promise<{ error: string | null }> {
  const { error } = await dbAnon.rpc('fn_kds_marcar_listo_comanda', { p_token: token, p_item_id: itemId });
  return { error: error?.message ?? null };
}

export async function recall(token: string, itemId: number): Promise<{ error: string | null }> {
  const { error } = await dbAnon.rpc('fn_kds_recall_comanda', { p_token: token, p_item_id: itemId });
  return { error: error?.message ?? null };
}
