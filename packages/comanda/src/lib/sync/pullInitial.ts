// pullInitial — snapshot completo de master data al inicio del turno.
//
// Se llama una vez al login POS (o al cambiar de local activo). Trae todo
// el catálogo + mesas + canales + empleados + (opcionalmente) ventas
// abiertas del local. Reemplaza el contenido de los stores locales con la
// versión cloud.
//
// Costo: ~500KB-2MB de transferencia. Aceptable porque corre 1-2 veces por
// día (login + cambio de local). Después corre `pullIncremental` cada 30s.
//
// Si falla por offline, propaga el error — el caller decide qué hacer
// (mostrar UI de "no se pudo iniciar turno", retry, etc).

import { db as supabase } from '../supabase';
import { itemsRepo } from '../db/repositories/itemsRepo';
import { gruposRepo } from '../db/repositories/gruposRepo';
import { mesasRepo } from '../db/repositories/mesasRepo';
import { ventasItemsRepo } from '../db/repositories/ventasRepo';
import { getDb } from '../db/index';
import type {
  LocalItem, LocalItemGrupo, LocalMesa, LocalCanal, LocalEmpleado,
  LocalVentaPos, LocalVentaItem, SyncMeta, StoreName,
} from '../db/schema';

export interface PullContext {
  tenantId: string;
  localId: number;
}

export interface PullResult {
  store: StoreName;
  count: number;
  durationMs: number;
}

// Marca el sync_meta de un store como "recién pulleado".
async function updateSyncMeta(store: StoreName, scope: string): Promise<void> {
  const db = await getDb();
  const pk = `${store}:${scope}`;
  const meta: SyncMeta & { pk: string } = {
    pk,
    store,
    scope,
    last_pull_at: new Date().toISOString(),
    last_full_sync_at: new Date().toISOString(),
  };
  await db.put('sync_meta', meta);
}

// ─── Pulls individuales por store ──────────────────────────────────────────

async function pullItems(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  const { data, error } = await supabase
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
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalItem[];
  await itemsRepo.replaceForTenant(ctx.tenantId, rows);
  await updateSyncMeta('items', ctx.tenantId);
  return { store: 'items', count: rows.length, durationMs: Math.round(performance.now() - t0) };
}

async function pullGrupos(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  const { data, error } = await supabase
    .from('item_grupos')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .order('orden', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalItemGrupo[];
  await gruposRepo.replaceForTenant(ctx.tenantId, rows);
  await updateSyncMeta('item_grupos', ctx.tenantId);
  return { store: 'item_grupos', count: rows.length, durationMs: Math.round(performance.now() - t0) };
}

async function pullMesas(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  const { data, error } = await supabase
    .from('mesas')
    .select('*')
    .eq('local_id', ctx.localId)
    .is('deleted_at', null);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalMesa[];
  await mesasRepo.replaceForLocal(ctx.localId, rows);
  await updateSyncMeta('mesas', `${ctx.tenantId}:${ctx.localId}`);
  return { store: 'mesas', count: rows.length, durationMs: Math.round(performance.now() - t0) };
}

async function pullCanales(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  const { data, error } = await supabase
    .from('canales')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .eq('activo', true);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalCanal[];
  const db = await getDb();
  const tx = db.transaction('canales', 'readwrite');
  await tx.store.clear();
  for (const r of rows) {
    await tx.store.put({ ...r, _local_dirty: false, _local_synced_at: new Date().toISOString() });
  }
  await tx.done;
  await updateSyncMeta('canales', ctx.tenantId);
  return { store: 'canales', count: rows.length, durationMs: Math.round(performance.now() - t0) };
}

async function pullEmpleados(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  const { data, error } = await supabase
    .from('rrhh_empleados')
    .select('id, local_id, apellido, nombre, puesto, activo, pos_activo, rol_pos, pin_actualizado_at, pos_favoritos')
    .eq('local_id', ctx.localId)
    .eq('activo', true)
    .eq('pos_activo', true);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LocalEmpleado[];
  const db = await getDb();
  const tx = db.transaction('empleados', 'readwrite');
  // Limpiar solo los del local activo
  const idx = tx.store.index('by_local');
  let cursor = await idx.openCursor(IDBKeyRange.only(ctx.localId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  for (const r of rows) {
    await tx.store.put({ ...r, _local_dirty: false, _local_synced_at: new Date().toISOString() });
  }
  await tx.done;
  await updateSyncMeta('empleados', `${ctx.tenantId}:${ctx.localId}`);
  return { store: 'empleados', count: rows.length, durationMs: Math.round(performance.now() - t0) };
}

// Ventas abiertas + sus items. Necesario para que cuando un cajero llegue a
// la sesión, vea las ventas en curso (otro mozo abrió la mesa hace 10min).
async function pullVentasAbiertas(ctx: PullContext): Promise<PullResult> {
  const t0 = performance.now();
  // Estados que consideramos "en curso"
  const { data: ventas, error: vErr } = await supabase
    .from('ventas_pos')
    .select('*')
    .eq('local_id', ctx.localId)
    .in('estado', ['abierta', 'enviada', 'lista', 'entregada'])
    .is('deleted_at', null);
  if (vErr) throw vErr;
  const vRows = (ventas ?? []) as unknown as LocalVentaPos[];

  // Pull items de esas ventas en batch (in clause con los ids)
  const ventaIds = vRows.map((v) => v.id);
  let iRows: LocalVentaItem[] = [];
  if (ventaIds.length > 0) {
    const { data: items, error: iErr } = await supabase
      .from('ventas_pos_items')
      .select('*')
      .in('venta_id', ventaIds)
      .is('deleted_at', null);
    if (iErr) throw iErr;
    iRows = (items ?? []) as unknown as LocalVentaItem[];
  }

  // AUDIT F5B#3: NO borrar ventas dirty (no-sincronizadas) — el comment viejo
  // decía "mantener las dirty" pero el código borraba TODAS. PoC del bug:
  // cajero cobra venta offline → otro cajero se loguea → pullVentasAbiertas
  // corre → la venta cobrada local desaparece y el server nunca recibe el
  // cobro (la op queue puede haber sido borrada por el reset DB también).
  // Ahora: skip rows con `_local_dirty=true`.
  const db = await getDb();
  const txV = db.transaction('ventas_pos', 'readwrite');
  const idxV = txV.store.index('by_local');
  let cursor = await idxV.openCursor(IDBKeyRange.only(ctx.localId));
  while (cursor) {
    const row = cursor.value;
    if (!row._local_dirty) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  for (const r of vRows) {
    // No sobreescribir una venta dirty con la versión del server
    const existing = await txV.store.get(r.id);
    if (existing && existing._local_dirty) continue;
    await txV.store.put({ ...r, _local_dirty: false, _local_synced_at: new Date().toISOString() });
  }
  await txV.done;

  // Items: borrar todos los items de las ventas afectadas + reinsertar.
  // ventasItemsRepo.deleteByVenta es genérico (no chequea dirty); para no
  // perder items locales dirty, filtramos venta_ids a las que NO tengan
  // venta dirty asociada.
  if (ventaIds.length > 0) {
    const txCheck = db.transaction('ventas_pos', 'readonly');
    const ventaIdsSafe: typeof ventaIds = [];
    for (const vId of ventaIds) {
      const v = await txCheck.store.get(vId);
      if (!v || !v._local_dirty) ventaIdsSafe.push(vId);
    }
    await txCheck.done;
    for (const vId of ventaIdsSafe) {
      await ventasItemsRepo.deleteByVenta(vId);
    }
    const iRowsSafe = iRows.filter(i => ventaIdsSafe.includes(i.venta_id));
    await ventasItemsRepo.putMany(iRowsSafe, { skipDirty: true });
  }

  await updateSyncMeta('ventas_pos', `${ctx.tenantId}:${ctx.localId}`);
  await updateSyncMeta('ventas_pos_items', `${ctx.tenantId}:${ctx.localId}`);
  return {
    store: 'ventas_pos',
    count: vRows.length,
    durationMs: Math.round(performance.now() - t0),
  };
}

// ─── Orquestador ────────────────────────────────────────────────────────────

// Corre todos los pulls en paralelo donde es seguro (no hay deps entre
// stores). Devuelve resultados por store + duración total.
export async function pullInitialAll(ctx: PullContext): Promise<{
  results: PullResult[];
  totalDurationMs: number;
}> {
  const t0 = performance.now();
  const results = await Promise.all([
    pullItems(ctx),
    pullGrupos(ctx),
    pullMesas(ctx),
    pullCanales(ctx),
    pullEmpleados(ctx),
    pullVentasAbiertas(ctx),
  ]);
  return {
    results,
    totalDurationMs: Math.round(performance.now() - t0),
  };
}

// Para tests / debugging: pull de un solo store.
export const _internal = {
  pullItems,
  pullGrupos,
  pullMesas,
  pullCanales,
  pullEmpleados,
  pullVentasAbiertas,
};
