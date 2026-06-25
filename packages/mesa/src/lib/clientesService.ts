// clientesService — CRM básico de comensales para el panel MESA.
// Port de COMANDA: tabla `clientes` con RLS por tenant (el dueño ve los suyos).

import { db } from './supabase';

export interface Cliente {
  id: number;
  nombre: string | null;
  apellido: string | null;
  telefono: string | null;
  email: string | null;
  vip: boolean | null;
  notas: string | null;
  ultimo_pedido_at: string | null;
  total_pedidos: number | null;
  total_gastado: number | null;
}

export async function listClientes(
  opts: { search?: string; limit?: number } = {},
): Promise<{ data: Cliente[]; error: string | null }> {
  let q = db()
    .from('clientes')
    .select('id, nombre, apellido, telefono, email, vip, notas, ultimo_pedido_at, total_pedidos, total_gastado')
    .is('deleted_at', null)
    .order('ultimo_pedido_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 100);
  if (opts.search?.trim()) {
    const s = opts.search.trim();
    q = q.or(`telefono.ilike.%${s}%,nombre.ilike.%${s}%,apellido.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Cliente[], error: null };
}
