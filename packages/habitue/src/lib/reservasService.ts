// reservasService — solo lo que Habitué necesita para el historial 360° del
// comensal: sus reservas (cross-local del tenant).

import { db } from './supabase';

export interface Reserva {
  id: number;
  cliente_nombre: string;
  fecha_hora: string;
  personas: number;
  estado: string;
  local_id: number;
}

export async function listReservasByCliente(clienteId: number): Promise<{ data: Reserva[]; error: string | null }> {
  const { data, error } = await db()
    .from('reservas')
    .select('id, cliente_nombre, fecha_hora, personas, estado, local_id')
    .eq('cliente_id', clienteId)
    .is('deleted_at', null)
    .order('fecha_hora', { ascending: false })
    .limit(50);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Reserva[], error: null };
}
