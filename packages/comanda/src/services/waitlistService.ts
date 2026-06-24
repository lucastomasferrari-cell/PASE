import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

export type EstadoWaitlist = 'esperando' | 'llamado' | 'sentado' | 'cancelado';

export interface WaitlistEntry {
  id: number;
  tenant_id: string;
  local_id: number;
  cliente_nombre: string;
  cliente_telefono: string | null;
  personas: number;
  notas: string | null;
  estado: EstadoWaitlist;
  created_at: string;
  llamado_at: string | null;
  sentado_at: string | null;
  deleted_at: string | null;
}

export async function listWaitlistActiva(
  localId: number,
): Promise<{ data: WaitlistEntry[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- filtro explícito por local_id
  const { data, error } = await db
    .from('waitlist')
    .select('*')
    .eq('local_id', localId)
    .in('estado', ['esperando', 'llamado'])
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as WaitlistEntry[], error: null };
}

export interface WaitlistInput {
  clienteNombre: string;
  clienteTelefono?: string;
  personas: number;
  notas?: string;
}

export async function agregarWaitlist(
  tenantId: string,
  localId: number,
  input: WaitlistInput,
): Promise<{ data: WaitlistEntry | null; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- insert con local_id explícito
  const { data, error } = await db
    .from('waitlist')
    .insert({
      tenant_id: tenantId,
      local_id: localId,
      cliente_nombre: input.clienteNombre,
      cliente_telefono: input.clienteTelefono?.trim() || null,
      personas: input.personas,
      notas: input.notas?.trim() || null,
    })
    .select('*')
    .single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as WaitlistEntry, error: null };
}

export async function llamarWaitlist(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('waitlist')
    .update({ estado: 'llamado', llamado_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error?.message ?? null };
}

export async function sentarWaitlist(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('waitlist')
    .update({ estado: 'sentado', sentado_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error?.message ?? null };
}

export async function cancelarWaitlist(id: number): Promise<{ error: string | null }> {
  const { error } = await db
    .from('waitlist')
    .update({ estado: 'cancelado' })
    .eq('id', id);
  return { error: error?.message ?? null };
}
