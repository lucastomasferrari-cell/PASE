import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';

// Sprint 2 competitor F #10 — Item review queue.
// Lista items con score de completitud + flags de qué les falta para ser
// "data-completos". El manager los revisa, los completa, y marca revisados.

export interface ItemReviewRow {
  id: number;
  tenant_id: string;
  nombre: string;
  emoji: string | null;
  foto_url: string | null;
  grupo_id: number | null;
  precio_madre: number;
  estacion: string | null;
  tax_rate_id: number | null;
  receta_id_vigente: number | null;
  estado: string;
  visible_pos: boolean;
  revisado_completo_at: string | null;
  created_at: string;
  // Flags individuales
  falta_visual: boolean;
  falta_grupo: boolean;
  falta_precio: boolean;
  falta_estacion: boolean;
  falta_tax: boolean;
  falta_receta: boolean;
  falta_descripcion: boolean;
  score_completitud: number;
}

export async function listItemsReview(
  tenantId: string,
  opts: {
    soloNoRevisados?: boolean;
    scoreMaximo?: number;
  } = {},
): Promise<{ data: ItemReviewRow[]; error: string | null }> {
  let q = db
    .from('v_items_review_queue')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('score_completitud', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(500);
  if (opts.soloNoRevisados ?? true) q = q.is('revisado_completo_at', null);
  if (opts.scoreMaximo != null) q = q.lte('score_completitud', opts.scoreMaximo);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as ItemReviewRow[], error: null };
}

export async function marcarItemRevisado(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_item_revisado', { p_item_id: itemId });
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function desmarcarItemRevisado(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_desmarcar_item_revisado', { p_item_id: itemId });
  if (error) return { error: translateError(error) };
  return { error: null };
}
