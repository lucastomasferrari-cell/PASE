import { db } from '../lib/supabase';
import type { VentaPos, EstadoVenta } from '../types/database';

// Mapeo lógico de "tab" a estado de venta para el feed Pedidos.
// Nota: 'activos' = enviada/lista (en preparación o listo para entregar).
// 'completados' = entregada/cobrada.
export type PedidoTab = 'necesita_aprobacion' | 'programados' | 'activos' | 'listos' | 'completados';

const TAB_TO_ESTADOS: Record<PedidoTab, EstadoVenta[]> = {
  necesita_aprobacion: ['necesita_aprobacion'],
  programados:         ['programada'],
  activos:             ['enviada'],
  listos:              ['lista'],
  completados:         ['entregada', 'cobrada'],
};

export async function listPedidosPorTab(
  localId: number,
  tab: PedidoTab,
): Promise<{ data: VentaPos[]; error: string | null }> {
  const estados = TAB_TO_ESTADOS[tab];
  const { data, error } = await db
    .from('ventas_pos')
    .select('*')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .in('estado', estados)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPos[], error: null };
}

// Counters por tab (para badges en navegación).
export async function getCountersPedidos(localId: number): Promise<Record<PedidoTab, number>> {
  const { data } = await db
    .from('ventas_pos')
    .select('estado')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .is('deleted_at', null)
    .in('estado', ['necesita_aprobacion', 'programada', 'enviada', 'lista']);
  const out: Record<PedidoTab, number> = {
    necesita_aprobacion: 0, programados: 0, activos: 0, listos: 0, completados: 0,
  };
  for (const row of data ?? []) {
    const e = (row as { estado: EstadoVenta }).estado;
    for (const [tab, estados] of Object.entries(TAB_TO_ESTADOS)) {
      if (estados.includes(e)) {
        out[tab as PedidoTab] = (out[tab as PedidoTab] ?? 0) + 1;
      }
    }
  }
  return out;
}

export async function aprobarPedidoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_aprobar_pedido_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

export async function marcarListoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_listo_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

export async function marcarEntregadoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_entregado_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}
