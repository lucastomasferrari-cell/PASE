import { db } from '../lib/supabase';

// Marcas del tenant (multi-marca). Una marca agrupa locales; el menú se
// gestiona por marca. Solo lectura desde COMANDA (el ABM vive en Accesos).

export interface MarcaLite {
  id: number;
  nombre: string;
  slug: string;
  color_primary: string | null;
}

export async function listMarcas(tenantId: string | null): Promise<{ data: MarcaLite[]; error: string | null }> {
  let q = db
    .from('marcas')
    .select('id, nombre, slug, color_primary')
    .is('deleted_at', null)
    .eq('activo', true)
    .order('orden', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as MarcaLite[], error: null };
}
