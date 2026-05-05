import { db } from '../lib/supabase';
import type { ComandaLocalSettings, MetodoCobro } from '../types/database';

// ─── Métodos de cobro ────────────────────────────────────────────────────

export async function listMetodosCobro(localId: number | null): Promise<{ data: MetodoCobro[]; error: string | null }> {
  // Trae globales + del local específico, activos primero, ordenados por orden
  let q = db.from('metodos_cobro').select('*').is('deleted_at', null);
  if (localId !== null) {
    q = q.or(`local_id.is.null,local_id.eq.${localId}`);
  } else {
    q = q.is('local_id', null);
  }
  q = q.order('orden', { ascending: true }).order('id', { ascending: true });
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as MetodoCobro[], error: null };
}

export async function listMetodosCobroActivos(localId: number | null): Promise<{ data: MetodoCobro[]; error: string | null }> {
  const { data, error } = await listMetodosCobro(localId);
  if (error) return { data: [], error };
  return { data: data.filter((m) => m.activo), error: null };
}

// ─── Settings del local ──────────────────────────────────────────────────

export async function getLocalSettings(localId: number): Promise<{ data: ComandaLocalSettings | null; error: string | null }> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .limit(1);
  if (error) return { data: null, error: error.message };
  return { data: (data?.[0] as ComandaLocalSettings | undefined) ?? null, error: null };
}

export async function updateLocalSettings(
  id: number,
  patch: Partial<ComandaLocalSettings>,
): Promise<{ error: string | null }> {
  const { error } = await db.from('comanda_local_settings').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

// ─── Locales accesibles para el usuario ──────────────────────────────────
// Útil para selector de local en POS (dueño/admin ve todos del tenant).
export interface LocalSimple {
  id: number;
  nombre: string;
}

export async function listLocalesAccesibles(): Promise<{ data: LocalSimple[]; error: string | null }> {
  const { data, error } = await db
    .from('locales')
    .select('id, nombre')
    .order('id', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as LocalSimple[], error: null };
}
