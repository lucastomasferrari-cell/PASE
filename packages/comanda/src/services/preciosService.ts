import { db } from '../lib/supabase';
import type { ItemPrecioCanal } from '../types/database';
import { translateError } from '../lib/errors';

export async function listPreciosPorTenant(tenantId: string | null): Promise<{ data: ItemPrecioCanal[]; error: string | null }> {
  let q = db.from('item_precios_canal').select('*').is('deleted_at', null);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: data ?? [], error: null };
}

// Editar precio puntual (celda planilla). Marca edicion_manual=TRUE pero
// NO desata del madre (la atadura vive en el canal). El próximo aumento
// masivo lo pisa.
export async function setPrecioCelda(
  itemId: number,
  canalId: number,
  precio: number,
  tenantId: string,
  localId: number | null,
): Promise<{ error: string | null }> {
  const { data: existing, error: selErr } = await db
    .from('item_precios_canal')
    .select('id')
    .eq('item_id', itemId)
    .eq('canal_id', canalId)
    .is('deleted_at', null)
    .limit(1);
  if (selErr) return { error: selErr.message };

  if (existing && existing.length > 0 && existing[0]) {
    const { error } = await db
      .from('item_precios_canal')
      .update({ precio, edicion_manual: true })
      .eq('id', existing[0].id);
    return { error: error?.message ?? null };
  }

  const { error } = await db.from('item_precios_canal').insert({
    item_id: itemId,
    canal_id: canalId,
    precio,
    edicion_manual: true,
    vendible: true,
    tenant_id: tenantId,
    local_id: localId,
  });
  return { error: error?.message ?? null };
}

export async function setVendible(
  precioId: number,
  vendible: boolean,
): Promise<{ error: string | null }> {
  const { error } = await db.from('item_precios_canal').update({ vendible }).eq('id', precioId);
  return { error: error?.message ?? null };
}

export interface AumentoMasivoArgs {
  tenantId: string;
  localId: number | null;
  grupoId: number | null;
  porcentaje: number;
  redondeoA: number;
}

export interface AumentoMasivoResult {
  itemsAfectados: number;
  preciosRecalculados: number;
}

export async function aumentoMasivo(args: AumentoMasivoArgs): Promise<{ data: AumentoMasivoResult | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_aumento_masivo_precios', {
    p_tenant_id: args.tenantId,
    p_local_id: args.localId,
    p_grupo_id: args.grupoId,
    p_porcentaje: args.porcentaje,
    p_redondeo_a: args.redondeoA,
  });
  if (error) return { data: null, error: translateError(error) };
  // RPC retorna SETOF (items_afectados, precios_recalculados). Tomamos primer row.
  const arr = data as Array<{ items_afectados: number; precios_recalculados: number }> | null;
  const row = arr?.[0];
  if (!row) return { data: { itemsAfectados: 0, preciosRecalculados: 0 }, error: null };
  return {
    data: { itemsAfectados: row.items_afectados, preciosRecalculados: row.precios_recalculados },
    error: null,
  };
}

// Cuando cambia precio_madre de un item, recalcular sus precios en canales atados.
// Pisa edicion_manual con animación (la flag se devuelve en false).
export async function recalcularAtadosDeItem(itemId: number): Promise<{ error: string | null }> {
  // Strategy: leer item + canales atados + ipc del item, calcular nuevos precios, update batch.
  const [itemRes, canalesRes, ipcRes] = await Promise.all([
    db.from('items').select('id, precio_madre, tenant_id, local_id').eq('id', itemId).limit(1),
    db.from('canales').select('id, ajuste_madre_pct, redondeo_a, atado_madre').eq('atado_madre', true).is('deleted_at', null),
    db.from('item_precios_canal').select('id, canal_id').eq('item_id', itemId).is('deleted_at', null),
  ]);
  if (itemRes.error) return { error: itemRes.error.message };
  if (canalesRes.error) return { error: canalesRes.error.message };
  if (ipcRes.error) return { error: ipcRes.error.message };

  const item = itemRes.data?.[0];
  if (!item) return { error: 'Item no encontrado' };

  const canalById = new Map<number, { ajuste_madre_pct: number; redondeo_a: number }>();
  for (const c of canalesRes.data ?? []) {
    canalById.set(c.id as number, {
      ajuste_madre_pct: Number(c.ajuste_madre_pct),
      redondeo_a: Number(c.redondeo_a) || 1,
    });
  }

  const updates: Array<{ id: number; precio: number }> = [];
  for (const ipc of ipcRes.data ?? []) {
    const canal = canalById.get(ipc.canal_id as number);
    if (!canal) continue; // canal no atado, dejar como está
    const ajustado = Number(item.precio_madre) * (1 + canal.ajuste_madre_pct / 100);
    const redondeado = Math.round(ajustado / canal.redondeo_a) * canal.redondeo_a;
    updates.push({ id: ipc.id as number, precio: redondeado });
  }

  for (const u of updates) {
    const { error } = await db
      .from('item_precios_canal')
      .update({ precio: u.precio, edicion_manual: false })
      .eq('id', u.id);
    if (error) return { error: translateError(error) };
  }

  return { error: null };
}
