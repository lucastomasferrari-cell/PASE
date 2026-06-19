// offline2 — sincronización RxDB <-> Supabase.
//   PULL: incremental por updated_at (RLS del JWT aplica). Marca _deleted=false.
//   PUSH: NO upsert crudo — llama a las RPCs `_offline` (que computan
//         numero_local/modo, resuelven uuid→id y validan). Confirmado necesario
//         por el spike (numero_local/canal_id/idempotency_key son NOT NULL).
//   Estrategia Fase 1: el push CREA filas nuevas (id == null). Las ya
//   sincronizadas se saltan (el server deriva total/estado vía las RPCs de
//   item/pago). Editar/anular filas ya sincronizadas = Fase 2 (overrides).
//   El `id` bigint vuelve por el PULL (cierra el ciclo uuid→id).
//
//   Las llamadas a RPC (callAbrir/callAgregarItem/callAgregarPago) reciben el
//   cliente como parámetro → testeables con un cliente autenticado (mutante).
import { replicateRxCollection } from 'rxdb/plugins/replication';
import type { WithDeleted } from 'rxdb';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfflineDB } from './db';
import type { VentaDoc, ItemDoc, PagoDoc } from './schema';
// NOTA: este módulo NO importa el cliente de `../supabase` (que lee
// import.meta.env y tira al cargar). El cliente entra por parámetro → el
// módulo es importable en tests Node (Playwright mutante) sin Vite.

const BATCH = 100;
type Cp = { updated_at: string } | undefined;
const sinceOf = (cp: Cp) => cp?.updated_at ?? '1970-01-01T00:00:00Z';
const cpOf = (rows: { updated_at: string }[], prev: Cp): Cp =>
  rows.length ? { updated_at: rows[rows.length - 1]!.updated_at } : prev;

// ── Push: doc local → RPC `_offline`. Devuelven el id bigint del server. ──────

/** Crea la venta en el server. Idempotente por idempotency_uuid → devuelve id. */
export async function callAbrir(supa: SupabaseClient, v: VentaDoc): Promise<number> {
  const { data, error } = await supa.rpc('fn_abrir_venta_comanda_offline', {
    p_local_id: v.local_id, p_canal_id: v.canal_id, p_modo: v.modo,
    p_mesa_id: v.mesa_id, p_mozo_id: v.mozo_id, p_cajero_id: v.cajero_id,
    p_idempotency_uuid: v.idempotency_uuid, p_idempotency_key: v.idempotency_uuid,
  });
  if (error) throw error;
  return Number(data);
}

/** Agrega el ítem. OJO: esta RPC NO tiene p_idempotency_key (solo _uuid). */
export async function callAgregarItem(supa: SupabaseClient, ventaId: number | null, it: ItemDoc): Promise<number> {
  const { data, error } = await supa.rpc('fn_agregar_item_comanda_offline', {
    p_venta_id: ventaId, p_venta_idempotency_uuid: it.venta_idempotency_uuid,
    p_item_id: it.item_id, p_cantidad: it.cantidad, p_precio_unitario: it.precio_unitario,
    p_curso: it.curso, p_idempotency_uuid: it.idempotency_uuid,
  });
  if (error) throw error;
  return Number(data);
}

/** Registra el pago. p_idempotency_key (per-pago) es requerido por la RPC. */
export async function callAgregarPago(supa: SupabaseClient, ventaId: number | null, p: PagoDoc): Promise<number> {
  const { data, error } = await supa.rpc('fn_agregar_pago_venta_comanda_offline', {
    p_venta_id: ventaId, p_venta_idempotency_uuid: p.venta_idempotency_uuid,
    p_metodo: p.metodo, p_monto: p.monto, p_idempotency_key: p.idempotency_uuid,
    p_idempotency_uuid: p.idempotency_uuid,
  });
  if (error) throw error;
  return Number(data);
}

/** Resuelve el venta_id (bigint server) del padre por su idempotency_uuid. */
export async function resolverVentaId(supa: SupabaseClient, db: OfflineDB, ventaUuid: string): Promise<number | null> {
  const local = await db.ventas.findOne(ventaUuid).exec();
  if (local?.id != null) return local.id;
  const { data } = await supa.from('ventas_pos').select('id').eq('idempotency_uuid', ventaUuid).maybeSingle();
  return (data?.id as number | undefined) ?? null;
}

/**
 * Empuja TODO lo pendiente (id == null) en orden: ventas → items → pagos,
 * reconciliando el id bigint en el doc local. Determinístico (lo usa el test
 * mutante) y útil como flush manual. Las RPCs son idempotentes por uuid, así
 * que reintentar no duplica.
 */
export async function flushPending(supa: SupabaseClient, db: OfflineDB): Promise<void> {
  for (const v of await db.ventas.find({ selector: { id: null } }).exec()) {
    const id = await callAbrir(supa, v.toJSON() as VentaDoc);
    await v.patch({ id });
  }
  for (const it of await db.items.find({ selector: { id: null } }).exec()) {
    const ventaId = await resolverVentaId(supa, db, it.venta_idempotency_uuid);
    const id = await callAgregarItem(supa, ventaId, it.toJSON() as ItemDoc);
    await it.patch({ id });
  }
  for (const p of await db.pagos.find({ selector: { id: null } }).exec()) {
    const ventaId = await resolverVentaId(supa, db, p.venta_idempotency_uuid);
    const id = await callAgregarPago(supa, ventaId, p.toJSON() as PagoDoc);
    await p.patch({ id });
  }
}

// ── Replicación live (app) ────────────────────────────────────────────────────

export function startSync(db: OfflineDB, supa: SupabaseClient) {
  const states = [syncVentas(db, supa), syncItems(db, supa), syncPagos(db, supa)];
  return () => states.forEach((s) => s.cancel());
}

function syncVentas(db: OfflineDB, supa: SupabaseClient) {
  return replicateRxCollection<VentaDoc, Cp>({
    collection: db.ventas, replicationIdentifier: 'o2-ventas_pos', live: true, retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(cp, limit) {
        const { data, error } = await supa.from('ventas_pos')
          .select('idempotency_uuid,id,tenant_id,local_id,canal_id,modo,mesa_id,mozo_id,cajero_id,estado,subtotal,total,updated_at')
          .gt('updated_at', sinceOf(cp)).not('idempotency_uuid', 'is', null)
          .is('deleted_at', null).order('updated_at', { ascending: true }).limit(limit);
        if (error) throw error;
        const docs = (data ?? []).map((r) => ({ ...(r as VentaDoc), _deleted: false })) as WithDeleted<VentaDoc>[];
        return { documents: docs, checkpoint: cpOf(docs, cp) };
      },
    },
    push: {
      batchSize: BATCH,
      async handler(rows) {
        for (const r of rows) {
          const v = r.newDocumentState as VentaDoc;
          if (v.id != null) continue; // ya creada; total/estado los deriva el server
          await callAbrir(supa, v); // id se reconcilia por el pull
        }
        return [];
      },
    },
  });
}

function syncItems(db: OfflineDB, supa: SupabaseClient) {
  return replicateRxCollection<ItemDoc, Cp>({
    collection: db.items, replicationIdentifier: 'o2-ventas_pos_items', live: true, retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(cp, limit) {
        const { data, error } = await supa.from('ventas_pos_items')
          .select('idempotency_uuid,id,venta_idempotency_uuid,tenant_id,local_id,item_id,cantidad,precio_unitario,subtotal,curso,estado,updated_at')
          .gt('updated_at', sinceOf(cp)).not('idempotency_uuid', 'is', null)
          .is('deleted_at', null).order('updated_at', { ascending: true }).limit(limit);
        if (error) throw error;
        const docs = (data ?? []).map((r) => ({ ...(r as ItemDoc), _deleted: false })) as WithDeleted<ItemDoc>[];
        return { documents: docs, checkpoint: cpOf(docs, cp) };
      },
    },
    push: {
      batchSize: BATCH,
      async handler(rows) {
        for (const r of rows) {
          const it = r.newDocumentState as ItemDoc;
          if (it.id != null) continue;
          const ventaId = await resolverVentaId(supa, db, it.venta_idempotency_uuid);
          await callAgregarItem(supa, ventaId, it); // si la venta aún no está → throw → retry
        }
        return [];
      },
    },
  });
}

function syncPagos(db: OfflineDB, supa: SupabaseClient) {
  return replicateRxCollection<PagoDoc, Cp>({
    collection: db.pagos, replicationIdentifier: 'o2-ventas_pos_pagos', live: true, retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(cp, limit) {
        const { data, error } = await supa.from('ventas_pos_pagos')
          .select('idempotency_uuid,id,venta_idempotency_uuid,tenant_id,local_id,metodo,monto,estado,updated_at')
          .gt('updated_at', sinceOf(cp)).not('idempotency_uuid', 'is', null)
          .is('deleted_at', null).order('updated_at', { ascending: true }).limit(limit);
        if (error) throw error;
        const docs = (data ?? []).map((r) => ({ ...(r as PagoDoc), venta_idempotency_uuid: (r as PagoDoc).venta_idempotency_uuid ?? '', _deleted: false })) as WithDeleted<PagoDoc>[];
        return { documents: docs, checkpoint: cpOf(docs, cp) };
      },
    },
    push: {
      batchSize: BATCH,
      async handler(rows) {
        for (const r of rows) {
          const p = r.newDocumentState as PagoDoc;
          if (p.id != null) continue;
          const ventaId = await resolverVentaId(supa, db, p.venta_idempotency_uuid);
          await callAgregarPago(supa, ventaId, p);
        }
        return [];
      },
    },
  });
}
