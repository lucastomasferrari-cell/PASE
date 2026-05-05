import { db } from '../lib/supabase';
import type { VentaPosOverride } from '../types/database';

// Auditoría visible. La INSERT pasa exclusivamente por las RPCs (security definer)
// que usan ManagerOverrideDialog en UI.

export async function listOverridesVenta(ventaId: number): Promise<{ data: VentaPosOverride[]; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('venta_id', ventaId)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPosOverride[], error: null };
}

export async function listOverridesLocal(localId: number, days = 30): Promise<{ data: VentaPosOverride[]; error: string | null }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('local_id', localId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPosOverride[], error: null };
}
