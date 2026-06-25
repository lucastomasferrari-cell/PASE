// segmentosService — segmentos dinámicos de comensales, calculados desde los
// campos de `clientes` (sin migración). El corazón del marketing de retención.

import { db } from './supabase';
import type { Cliente } from './clientesService';

export type SegmentoKey =
  | 'perdidos' | 'riesgo' | 'recurrentes' | 'una_compra'
  | 'nuevos' | 'vip' | 'top_gasto' | 'marketing';

export interface SegmentoDef {
  key: SegmentoKey;
  label: string;
  descripcion: string;
  emoji: string;
  /** plantilla de campaña sugerida para este segmento */
  sugerencia: string;
}

export const SEGMENTOS: SegmentoDef[] = [
  { key: 'perdidos', label: 'Clientes perdidos', emoji: '🚪', descripcion: 'No piden hace más de 60 días (y antes pedían).', sugerencia: 'reactivar' },
  { key: 'riesgo', label: 'En riesgo', emoji: '⚠️', descripcion: 'Sin pedir hace 30 a 60 días — antes de perderlos.', sugerencia: 'reactivar' },
  { key: 'una_compra', label: 'Una sola compra', emoji: '🔂', descripcion: 'Compraron una vez y no volvieron. "Comprá de nuevo".', sugerencia: 'segunda_compra' },
  { key: 'recurrentes', label: 'Recurrentes', emoji: '💚', descripcion: '5 pedidos o más. Tus habitués — cuidalos.', sugerencia: 'fidelizar' },
  { key: 'top_gasto', label: 'Top gasto', emoji: '💎', descripcion: 'Los que más gastaron en total.', sugerencia: 'fidelizar' },
  { key: 'nuevos', label: 'Nuevos', emoji: '✨', descripcion: 'Primer pedido en los últimos 30 días. Dales la bienvenida.', sugerencia: 'bienvenida' },
  { key: 'vip', label: 'VIP', emoji: '⭐', descripcion: 'Marcados como VIP a mano.', sugerencia: 'fidelizar' },
  { key: 'marketing', label: 'Aceptan promos', emoji: '📣', descripcion: 'Dieron OK para recibir marketing.', sugerencia: 'promo' },
];

function diasAtras(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString();
}

const COLS = 'id, nombre, apellido, telefono, email, vip, notas, acepta_marketing, ultimo_pedido_at, primer_pedido_at, total_pedidos, total_gastado';

// Aplica el filtro del segmento a una query de clientes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el builder de supabase es difícil de tipar genéricamente
function aplicar(q: any, key: SegmentoKey): any {
  switch (key) {
    case 'perdidos':    return q.gte('total_pedidos', 1).lt('ultimo_pedido_at', diasAtras(60));
    case 'riesgo':      return q.gte('ultimo_pedido_at', diasAtras(60)).lt('ultimo_pedido_at', diasAtras(30));
    case 'una_compra':  return q.eq('total_pedidos', 1);
    case 'recurrentes': return q.gte('total_pedidos', 5);
    case 'top_gasto':   return q.gt('total_gastado', 0);
    case 'nuevos':      return q.gte('primer_pedido_at', diasAtras(30));
    case 'vip':         return q.eq('vip', true);
    case 'marketing':   return q.eq('acepta_marketing', true);
  }
}

export async function contarSegmento(key: SegmentoKey): Promise<number> {
  let q = db().from('clientes').select('id', { count: 'exact', head: true }).is('deleted_at', null);
  q = aplicar(q, key);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

export async function listSegmento(key: SegmentoKey, limit = 500): Promise<{ data: Cliente[]; error: string | null }> {
  let q = db().from('clientes').select(COLS).is('deleted_at', null);
  q = aplicar(q, key);
  q = key === 'top_gasto'
    ? q.order('total_gastado', { ascending: false })
    : q.order('ultimo_pedido_at', { ascending: false, nullsFirst: false });
  q = q.limit(limit);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Cliente[], error: null };
}
