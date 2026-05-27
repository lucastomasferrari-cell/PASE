// pullIncremental — trae solo los changes desde el último pull.
//
// Filtra por `updated_at > last_pull_at` en cada tabla. MUCHO más liviano
// que el pullInitial (solo trae deltas) — se corre cada 30s mientras hay
// internet.
//
// Conflict resolution: si una fila viene del cloud y localmente está dirty
// (cambio pendiente de push), llamamos al resolver (LWW + audit).

import { db as supabase } from '../supabase';
import { getDb } from '../db/index';
import { itemsRepo } from '../db/repositories/itemsRepo';
import { gruposRepo } from '../db/repositories/gruposRepo';
import { mesasRepo } from '../db/repositories/mesasRepo';
import { ventasRepo, ventasItemsRepo } from '../db/repositories/ventasRepo';
import { resolveLWW, logConflict } from './conflictResolver';
import type {
  StoreName, SyncMeta, LocalItem, LocalItemGrupo, LocalMesa,
  LocalVentaPos, LocalVentaItem, LocalMeta,
} from '../db/schema';

export interface PullCtx {
  tenantId: string;
  localId: number;
}

export interface PullDelta {
  store: StoreName;
  fetched: number;
  applied: number;
  conflicts: number;
  durationMs: number;
}

async function getLastPullAt(store: StoreName, scope: string): Promise<string | null> {
  const db = await getDb();
  const meta = (await db.get('sync_meta', `${store}:${scope}`)) as
    | (SyncMeta & { pk: string })
    | undefined;
  return meta?.last_pull_at ?? null;
}

async function setLastPullAt(store: StoreName, scope: string): Promise<void> {
  const db = await getDb();
  const meta = (await db.get('sync_meta', `${store}:${scope}`)) as
    | (SyncMeta & { pk: string })
    | undefined;
  await db.put('sync_meta', {
    pk: `${store}:${scope}`,
    store,
    scope,
    last_pull_at: new Date().toISOString(),
    last_full_sync_at: meta?.last_full_sync_at ?? null,
  });
}

// Aplica un row del cloud al local, resolviendo conflicto si hace falta.
// Devuelve true si la aplicación generó conflicto (loged).
async function applyCloudRow<T extends { id: string | number; updated_at: string }>(
  store: StoreName,
  cloudRow: T,
): Promise<boolean> {
  const db = await getDb();
  const local = (await db.get(store, cloudRow.id)) as (T & LocalMeta) | undefined;

  if (!local) {
    // No hay local: aplicar cloud directo (skipDirty implícito)
    await db.put(store, { ...cloudRow, _local_dirty: false, _local_synced_at: new Date().toISOString() });
    return false;
  }

  // Hay local: aplicar resolver
  const resolution = resolveLWW(local as T & LocalMeta, cloudRow as T & LocalMeta, {
    store,
    rowId: cloudRow.id,
  });

  if (resolution === 'cloud_wins') {
    await db.put(store, { ...cloudRow, _local_dirty: false, _local_synced_at: new Date().toISOString() });
    if (local._local_dirty) {
      // Local tenía cambios pendientes pero el cloud ganó — auditamos.
      await logConflict({
        store, rowId: cloudRow.id,
        localValue: local, cloudValue: cloudRow,
        resolution: 'cloud_wins',
        note: 'Cloud más nuevo, local dirty perdió',
      });
      return true;
    }
    return false;
  }

  if (resolution === 'local_wins') {
    // Local más nuevo — NO sobrescribir. El push engine va a pushearlo
    // de vuelta al cloud en su próximo ciclo.
    if (local._local_dirty) {
      await logConflict({
        store, rowId: cloudRow.id,
        localValue: local, cloudValue: cloudRow,
        resolution: 'local_wins',
        note: 'Local más nuevo, pendiente de push',
      });
      return true;
    }
    return false;
  }

  // manual_pending: NO aplicar nada, dejar que el manager resuelva via UI
  await logConflict({
    store, rowId: cloudRow.id,
    localValue: local, cloudValue: cloudRow,
    resolution: 'manual_pending',
    note: 'Requiere intervención de manager',
  });
  return true;
}

// ─── Pulls incrementales por store ─────────────────────────────────────────

async function pullItemsIncremental(ctx: PullCtx): Promise<PullDelta> {
  const t0 = performance.now();
  const since = await getLastPullAt('items', ctx.tenantId);
  let q = supabase
    .from('items')
    .select(`
      id, tenant_id, local_id, created_at, updated_at, deleted_at,
      nombre, descripcion, emoji, foto_url, codigo,
      grupo_id, orden, precio_madre, costo_actual,
      tax_rate_id, estacion, estado,
      agotado_motivo, agotado_at, agotado_hasta, es_combo,
      tiempo_prep_min, receta_id_vigente, receta_version_id_vigente,
      visible_pos, visible_qr, visible_tienda, es_open_item
    `)
    .eq('tenant_id', ctx.tenantId);
  if (since) q = q.gt('updated_at', since);
  const { data, error } = await q.limit(500);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalItem[];
  let conflicts = 0;
  for (const r of rows) {
    if (r.deleted_at) {
      await itemsRepo.delete(r.id);
    } else {
      const hadConflict = await applyCloudRow('items', r);
      if (hadConflict) conflicts++;
    }
  }
  await setLastPullAt('items', ctx.tenantId);
  return {
    store: 'items', fetched: rows.length, applied: rows.length - conflicts,
    conflicts, durationMs: Math.round(performance.now() - t0),
  };
}

async function pullGruposIncremental(ctx: PullCtx): Promise<PullDelta> {
  const t0 = performance.now();
  const since = await getLastPullAt('item_grupos', ctx.tenantId);
  let q = supabase.from('item_grupos').select('*').eq('tenant_id', ctx.tenantId);
  if (since) q = q.gt('updated_at', since);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalItemGrupo[];
  let conflicts = 0;
  for (const r of rows) {
    if (r.deleted_at) {
      await gruposRepo.delete(r.id);
    } else {
      const hadConflict = await applyCloudRow('item_grupos', r);
      if (hadConflict) conflicts++;
    }
  }
  await setLastPullAt('item_grupos', ctx.tenantId);
  return {
    store: 'item_grupos', fetched: rows.length, applied: rows.length - conflicts,
    conflicts, durationMs: Math.round(performance.now() - t0),
  };
}

async function pullMesasIncremental(ctx: PullCtx): Promise<PullDelta> {
  const t0 = performance.now();
  const scope = `${ctx.tenantId}:${ctx.localId}`;
  const since = await getLastPullAt('mesas', scope);
  let q = supabase.from('mesas').select('*').eq('local_id', ctx.localId);
  if (since) q = q.gt('updated_at', since);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalMesa[];
  let conflicts = 0;
  for (const r of rows) {
    if (r.deleted_at) {
      await mesasRepo.delete(r.id);
    } else {
      const hadConflict = await applyCloudRow('mesas', r);
      if (hadConflict) conflicts++;
    }
  }
  await setLastPullAt('mesas', scope);
  return {
    store: 'mesas', fetched: rows.length, applied: rows.length - conflicts,
    conflicts, durationMs: Math.round(performance.now() - t0),
  };
}

async function pullVentasIncremental(ctx: PullCtx): Promise<PullDelta> {
  const t0 = performance.now();
  const scope = `${ctx.tenantId}:${ctx.localId}`;
  const since = await getLastPullAt('ventas_pos', scope);
  let q = supabase.from('ventas_pos').select('*').eq('local_id', ctx.localId);
  if (since) q = q.gt('updated_at', since);
  const { data, error } = await q.limit(200);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalVentaPos[];
  let conflicts = 0;
  for (const r of rows) {
    if (r.deleted_at) {
      await ventasRepo.delete(r.id);
    } else {
      const hadConflict = await applyCloudRow('ventas_pos', r);
      if (hadConflict) conflicts++;
    }
  }
  await setLastPullAt('ventas_pos', scope);
  return {
    store: 'ventas_pos', fetched: rows.length, applied: rows.length - conflicts,
    conflicts, durationMs: Math.round(performance.now() - t0),
  };
}

async function pullVentasItemsIncremental(ctx: PullCtx): Promise<PullDelta> {
  const t0 = performance.now();
  const scope = `${ctx.tenantId}:${ctx.localId}`;
  const since = await getLastPullAt('ventas_pos_items', scope);
  // AUDIT F5A#2: filtrar por local_id explícito. Antes confiaba en RLS pero
  // si el usuario tiene visibilidad cross-local (dueño con acceso a varios),
  // recibía deltas de items de OTROS locales, que terminaban en IndexedDB
  // del local activo. Al cambiar de local, mezclas. La columna `local_id`
  // existe en ventas_pos_items (redundante con la de su venta padre).
  let q = supabase.from('ventas_pos_items').select('*').eq('local_id', ctx.localId);
  if (since) q = q.gt('updated_at', since);
  const { data, error } = await q.limit(500);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalVentaItem[];
  let conflicts = 0;
  for (const r of rows) {
    if (r.deleted_at) {
      await ventasItemsRepo.delete(r.id);
    } else {
      const hadConflict = await applyCloudRow('ventas_pos_items', r);
      if (hadConflict) conflicts++;
    }
  }
  await setLastPullAt('ventas_pos_items', scope);
  return {
    store: 'ventas_pos_items', fetched: rows.length, applied: rows.length - conflicts,
    conflicts, durationMs: Math.round(performance.now() - t0),
  };
}

// ─── Orquestador ────────────────────────────────────────────────────────────

export async function pullIncrementalAll(ctx: PullCtx): Promise<{
  results: PullDelta[];
  totalDurationMs: number;
  totalConflicts: number;
}> {
  const t0 = performance.now();
  const results = await Promise.all([
    pullItemsIncremental(ctx),
    pullGruposIncremental(ctx),
    pullMesasIncremental(ctx),
    pullVentasIncremental(ctx),
    pullVentasItemsIncremental(ctx),
  ]);
  return {
    results,
    totalDurationMs: Math.round(performance.now() - t0),
    totalConflicts: results.reduce((s, r) => s + r.conflicts, 0),
  };
}
