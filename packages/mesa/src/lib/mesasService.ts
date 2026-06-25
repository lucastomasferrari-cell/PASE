// mesasService — mesas del local + estado en vivo, para el plano del panel MESA.
// Port de COMANDA: misma tabla `mesas` y misma RPC `fn_estado_mesas_live`
// (SECURITY INVOKER → estado por mesa leyendo ventas_pos + reservas).

import { db } from './supabase';

export type FormaMesa = 'redondo' | 'cuadrado' | 'rectangular';
export type EstadoMesaLive = 'libre' | 'ocupada_ticket' | 'ocupada_reserva' | 'reservada_pronto';

export interface Mesa {
  id: number;
  local_id: number;
  numero: string | number;
  zona: string | null;
  capacidad: number | null;
  forma: FormaMesa;
  pos_x: number | null;
  pos_y: number | null;
  ancho: number;
  alto: number;
}

export interface MesaEstadoLive {
  mesa_id: number;
  estado_live: EstadoMesaLive;
  venta_id: number | null;
  venta_total: number | null;
  venta_abierta_at: string | null;
  reserva_id: number | null;
  reserva_nombre: string | null;
  reserva_hora: string | null;
  reserva_personas: number | null;
}

export async function listMesas(localId: number): Promise<{ data: Mesa[]; error: string | null }> {
  const { data, error } = await db()
    .from('mesas')
    .select('id, local_id, numero, zona, capacidad, forma, pos_x, pos_y, ancho, alto')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('zona', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Mesa[], error: null };
}

export async function estadoMesasLive(localId: number): Promise<{ data: MesaEstadoLive[]; error: string | null }> {
  const { data, error } = await db().rpc('fn_estado_mesas_live', { p_local_id: localId });
  if (error) return { data: [], error: error.message };
  return {
    data: (data ?? []).map((r: Record<string, unknown>) => ({
      mesa_id: Number(r['mesa_id']),
      estado_live: r['estado_live'] as EstadoMesaLive,
      venta_id: r['venta_id'] != null ? Number(r['venta_id']) : null,
      venta_total: r['venta_total'] != null ? Number(r['venta_total']) : null,
      venta_abierta_at: (r['venta_abierta_at'] as string | null) ?? null,
      reserva_id: r['reserva_id'] != null ? Number(r['reserva_id']) : null,
      reserva_nombre: (r['reserva_nombre'] as string | null) ?? null,
      reserva_hora: (r['reserva_hora'] as string | null) ?? null,
      reserva_personas: r['reserva_personas'] != null ? Number(r['reserva_personas']) : null,
    })),
    error: null,
  };
}
