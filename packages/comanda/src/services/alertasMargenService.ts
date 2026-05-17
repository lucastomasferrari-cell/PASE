import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

// Sprint 1 competitor F #4 — Alertas de margen por auto-recosting.
// Generadas por trigger fn_recosting_alerta_margen al subir costo de un
// insumo y empujar el margen de la receta > umbral (5pp). El dueño decide:
// subir precio, asumir el margen menor, o dismiss.

export interface AlertaMargen {
  id: number;
  created_at: string;
  item_id: number;
  item_nombre: string;
  item_emoji: string | null;
  receta_id: number;
  trigger_insumo_id: number | null;
  trigger_insumo_nombre: string | null;
  precio_actual: number;
  costo_anterior: number;
  costo_nuevo: number;
  margen_anterior_pct: number | null;
  margen_nuevo_pct: number | null;
  caida_pp: number | null;
  local_id: number | null;
}

export type AccionAlerta = 'precio_actualizado' | 'asumido' | 'dismiss';

export async function listAlertasActivas(): Promise<{ data: AlertaMargen[]; error: string | null }> {
  const { data, error } = await db.rpc('fn_alertas_margen_activas');
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as AlertaMargen[], error: null };
}

export async function reconocerAlerta(
  alertaId: number,
  accion: AccionAlerta,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_reconocer_alerta_margen', {
    p_alerta_id: alertaId,
    p_accion: accion,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}
