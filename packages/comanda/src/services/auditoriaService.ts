import { db } from '../lib/supabase';
import type { VentaPosOverride, AccionOverride } from '../types/database';

export interface AuditoriaFilter {
  localId: number;
  cajeroId?: string;
  managerId?: string;
  accion?: AccionOverride;
  desde?: Date;
  hasta?: Date;
  limit?: number;
}

export async function listOverrides(f: AuditoriaFilter): Promise<{ data: VentaPosOverride[]; error: string | null }> {
  let q = db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('local_id', f.localId);
  if (f.cajeroId) q = q.eq('cajero_id', f.cajeroId);
  if (f.managerId) q = q.eq('manager_id', f.managerId);
  if (f.accion) q = q.eq('accion', f.accion);
  if (f.desde) q = q.gte('created_at', f.desde.toISOString());
  if (f.hasta) q = q.lte('created_at', f.hasta.toISOString());
  q = q.order('created_at', { ascending: false }).limit(f.limit ?? 200);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPosOverride[], error: null };
}

export async function getOverride(id: number): Promise<{ data: VentaPosOverride | null; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (error) return { data: null, error: error.message };
  return { data: (data?.[0] as VentaPosOverride | undefined) ?? null, error: null };
}
