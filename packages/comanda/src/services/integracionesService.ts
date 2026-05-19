// integracionesService — gestión de credenciales para partners externos
// (Rappi, PedidosYa, Deliverect). Las credentials nunca se leen del
// frontend — solo se envían al server via fn_upsert_integracion. El
// frontend solo ve estado + last_test_at + notas.

import { db } from '../lib/supabase';

export type ExternalProvider = 'rappi' | 'pedidos-ya' | 'deliverect';
export type IntegracionEstado = 'configured' | 'active' | 'error';

export interface IntegracionPublica {
  id: number;
  tenant_id: string;
  provider: ExternalProvider;
  estado: IntegracionEstado;
  last_test_at: string | null;
  last_error: string | null;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

export async function listIntegraciones(): Promise<{ data: IntegracionPublica[]; error: string | null }> {
  const { data, error } = await db
    .from('integraciones_externas_credenciales')
    .select('id, tenant_id, provider, estado, last_test_at, last_error, notas, created_at, updated_at')
    .order('provider');
  if (error) return { data: [], error: error.message };
  return { data: (data as IntegracionPublica[]) ?? [], error: null };
}

export async function getIntegracion(provider: ExternalProvider): Promise<{ data: IntegracionPublica | null; error: string | null }> {
  const { data, error } = await db
    .from('integraciones_externas_credenciales')
    .select('id, tenant_id, provider, estado, last_test_at, last_error, notas, created_at, updated_at')
    .eq('provider', provider)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: (data as IntegracionPublica | null), error: null };
}

export async function upsertIntegracion(args: {
  provider: ExternalProvider;
  credentials: Record<string, string>;
  notas?: string | null;
}): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await db.rpc('fn_upsert_integracion', {
    p_provider: args.provider,
    p_credentials: args.credentials,
    p_notas: args.notas ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function eliminarIntegracion(provider: ExternalProvider): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await db.rpc('fn_eliminar_integracion', { p_provider: provider });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

// ─── Mapeos de locales externos ────────────────────────────────────────────

export interface MapeoLocal {
  id: number;
  tenant_id: string;
  provider: ExternalProvider;
  external_local_id: string;
  local_id: number;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export async function listMapeos(provider: ExternalProvider): Promise<{ data: MapeoLocal[]; error: string | null }> {
  const { data, error } = await db
    .from('mapeos_locales_externos')
    .select('id, tenant_id, provider, external_local_id, local_id, activo, created_at, updated_at')
    .eq('provider', provider)
    .order('local_id');
  if (error) return { data: [], error: error.message };
  return { data: (data as MapeoLocal[]) ?? [], error: null };
}

export async function upsertMapeo(args: {
  provider: ExternalProvider;
  externalLocalId: string;
  localId: number;
  activo?: boolean;
}): Promise<{ ok: boolean; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- mapeo de configuración, RLS valida tenant
  const { error } = await db.from('mapeos_locales_externos').upsert({
    provider: args.provider,
    external_local_id: args.externalLocalId,
    local_id: args.localId,
    activo: args.activo ?? true,
  }, { onConflict: 'provider,external_local_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function eliminarMapeo(id: number): Promise<{ ok: boolean; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- delete por PK del mapeo, RLS valida tenant
  const { error } = await db.from('mapeos_locales_externos').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
