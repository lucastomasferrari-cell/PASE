import { db } from '../lib/supabase';
import type { Cliente } from '../types/database';
import { translateError } from '../lib/errors';

// Service de CRM básico (F1.2, auditoría 2026-05-15).
// La tabla `clientes` tiene RLS por tenant — el dueño/admin de Neko ve solo
// los suyos. No usa applyLocalScope porque clientes son del tenant entero,
// no de un local específico.

export interface ListClientesOpts {
  search?: string; // matchea telefono o nombre
  limit?: number;
  onlyVip?: boolean;
}

export async function listClientes(
  opts: ListClientesOpts = {},
): Promise<{ data: Cliente[]; error: string | null }> {
  let q = db
    .from('clientes')
    .select('*')
    .is('deleted_at', null)
    .order('ultimo_pedido_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 100);

  if (opts.search?.trim()) {
    const s = opts.search.trim();
    // Postgres ilike no soporta OR fluently en Supabase JS — usamos .or().
    q = q.or(`telefono.ilike.%${s}%,nombre.ilike.%${s}%,apellido.ilike.%${s}%`);
  }
  if (opts.onlyVip) {
    q = q.eq('vip', true);
  }
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Cliente[], error: null };
}

export async function getCliente(id: number): Promise<{ data: Cliente | null; error: string | null }> {
  const { data, error } = await db
    .from('clientes').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Cliente | null, error: null };
}

export interface ClienteInput {
  telefono: string;
  nombre?: string | null;
  apellido?: string | null;
  email?: string | null;
  direccion?: string | null;
  direccion_aclaracion?: string | null;
  zona?: string | null;
  notas?: string | null;
  vip?: boolean;
  acepta_marketing?: boolean;
}

// Crea cliente nuevo en el tenant del caller. Si telefono ya existe (UNIQUE
// parcial), devuelve error. Para crear-o-actualizar usar fn_upsert_cliente_publico_comanda
// (es para tienda anon) o llamarse update con id existente.
export async function createCliente(
  tenantId: string,
  input: ClienteInput,
): Promise<{ data: Cliente | null; error: string | null }> {
  const { data, error } = await db
    .from('clientes')
    .insert({ tenant_id: tenantId, ...input })
    .select('*')
    .single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Cliente, error: null };
}

export async function updateCliente(
  id: number,
  patch: Partial<ClienteInput>,
): Promise<{ data: Cliente | null; error: string | null }> {
  const { data, error } = await db
    .from('clientes').update(patch).eq('id', id).select('*').single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Cliente, error: null };
}

// Soft delete. Si el telefono se quiere reusar después, primero hacer
// hard delete o restore manual.
export async function softDeleteCliente(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('clientes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error?.message ?? null };
}
