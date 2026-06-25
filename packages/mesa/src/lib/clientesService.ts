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

export interface ClienteInput {
  nombre?: string | null;
  apellido?: string | null;
  telefono: string;
  email?: string | null;
  vip?: boolean;
  notas?: string | null;
}

export async function createCliente(tenantId: string, input: ClienteInput): Promise<{ data: Cliente | null; error: string | null }> {
  const { data, error } = await db()
    .from('clientes')
    .insert({ tenant_id: tenantId, ...input })
    .select('id, nombre, apellido, telefono, email, vip, notas, ultimo_pedido_at, total_pedidos, total_gastado')
    .single();
  if (error) return { data: null, error: error.message };
  return { data: data as Cliente, error: null };
}

export async function updateCliente(id: number, patch: Partial<ClienteInput>): Promise<{ error: string | null }> {
  const { error } = await db().from('clientes').update(patch).eq('id', id);
  return { error: error?.message ?? null };
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
