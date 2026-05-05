import { db } from '../lib/supabase';
import type { ComandaLocalSettings, MetodoCobro, PosModo } from '../types/database';

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

// ─── Features POS por local ──────────────────────────────────────────────
// Lee comanda_local_settings.features_pos_modos. Fallback a los 3 modos si
// no hay row de settings o la query falla.

const DEFAULT_MODOS: PosModo[] = ['salon', 'mostrador', 'pedidos'];

export async function getFeaturesPosModos(localId: number): Promise<PosModo[]> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('features_pos_modos')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .limit(1);
  if (error || !data?.[0]) return DEFAULT_MODOS;
  const modos = (data[0] as { features_pos_modos?: PosModo[] }).features_pos_modos;
  return Array.isArray(modos) && modos.length > 0 ? modos : DEFAULT_MODOS;
}
