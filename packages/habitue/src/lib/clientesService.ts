// clientesService — base de comensales (CRM) de Habitué. Tabla `clientes`,
// RLS por tenant. Mismo modelo que MESA/COMANDA.

import { db } from './supabase';

export interface Cliente {
  id: number;
  nombre: string | null;
  apellido: string | null;
  telefono: string | null;
  email: string | null;
  vip: boolean | null;
  notas: string | null;
  acepta_marketing: boolean | null;
  ultimo_pedido_at: string | null;
  primer_pedido_at: string | null;
  total_pedidos: number | null;
  total_gastado: number | null;
}

const COLS = 'id, nombre, apellido, telefono, email, vip, notas, acepta_marketing, ultimo_pedido_at, primer_pedido_at, total_pedidos, total_gastado';

export interface ListClientesOpts {
  search?: string;
  limit?: number;
  onlyVip?: boolean;
  onlyMarketing?: boolean;
}

export async function listClientes(opts: ListClientesOpts = {}): Promise<{ data: Cliente[]; error: string | null }> {
  let q = db()
    .from('clientes')
    .select(COLS)
    .is('deleted_at', null)
    .order('ultimo_pedido_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 200);
  if (opts.search?.trim()) {
    const s = opts.search.trim();
    q = q.or(`telefono.ilike.%${s}%,nombre.ilike.%${s}%,apellido.ilike.%${s}%,email.ilike.%${s}%`);
  }
  if (opts.onlyVip) q = q.eq('vip', true);
  if (opts.onlyMarketing) q = q.eq('acepta_marketing', true);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Cliente[], error: null };
}

export interface ClienteInput {
  nombre?: string | null;
  apellido?: string | null;
  telefono: string;
  email?: string | null;
  vip?: boolean;
  acepta_marketing?: boolean;
  notas?: string | null;
}

export async function createCliente(tenantId: string, input: ClienteInput): Promise<{ data: Cliente | null; error: string | null }> {
  const { data, error } = await db().from('clientes').insert({ tenant_id: tenantId, ...input }).select(COLS).single();
  if (error) return { data: null, error: error.message };
  return { data: data as Cliente, error: null };
}

export async function updateCliente(id: number, patch: Partial<ClienteInput>): Promise<{ error: string | null }> {
  const { error } = await db().from('clientes').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function eliminarCliente(id: number): Promise<{ error: string | null }> {
  const { error } = await db().from('clientes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
