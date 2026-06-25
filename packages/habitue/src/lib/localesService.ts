// localesService — lista los locales del tenant con su slug (de
// comanda_local_settings). Lo usa Calidad para elegir el local de las reseñas.

import { db } from './supabase';

export interface LocalLite {
  settings_id: number;
  local_id: number;
  nombre: string;
  slug: string | null;
}

export async function listLocales(): Promise<{ data: LocalLite[]; error: string | null }> {
  const { data, error } = await db()
    .from('comanda_local_settings')
    .select('id, local_id, slug, locales(nombre)')
    .is('deleted_at', null)
    .order('local_id');
  if (error) return { data: [], error: error.message };
  const rows = (data ?? []).map((r) => {
    const row = r as unknown as { id: number; local_id: number; slug: string | null; locales: { nombre: string } | null };
    return { settings_id: row.id, local_id: row.local_id, nombre: row.locales?.nombre ?? `Local ${row.local_id}`, slug: row.slug } satisfies LocalLite;
  });
  return { data: rows, error: null };
}
