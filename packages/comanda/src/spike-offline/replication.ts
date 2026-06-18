// SPIKE — replicación RxDB <-> Supabase (descartable). Valida el sync.
//
// PULL: trae filas con updated_at > checkpoint (RLS del JWT logueado aplica →
//       valida criterio "no leakea entre locales"). Filtra idempotency_uuid
//       NOT NULL (filas legacy sin uuid no entran al store local). Marca
//       _deleted=false (protocolo de replicación de RxDB).
// PUSH: sube los cambios locales. Acá viven los HALLAZGOS del rebuild:
//   - identidad: el id real es bigint del server; offline usamos idempotency_uuid.
//   - items/pagos linkean al padre por venta_idempotency_uuid → al subir hay que
//     resolver el venta_id (bigint) del padre. Si el padre aún no se subió,
//     se difiere (throw → reintento). Patrón local-first correcto.
//   - ventas_pos_pagos NO tiene columna venta_idempotency_uuid (items SÍ) →
//     se quita antes del upsert. EL REBUILD DEBE AGREGAR ESA COLUMNA
//     (origen del bug __pending_parent__).
import { replicateRxCollection } from 'rxdb/plugins/replication';
import type { WithDeleted } from 'rxdb';
import { db as supa } from '../lib/supabase';
import type { SpikeDB } from './db';
import type { VentaDoc, ItemDoc, PagoDoc } from './schema';

const BATCH = 100;
const META = new Set(['_deleted', '_meta', '_rev', '_attachments']);

export function startReplication(db: SpikeDB) {
  const states = [replVentas(db), replItems(db), replPagos(db)];
  return () => states.forEach((s) => s.cancel());
}

type Cp = { updated_at: string } | undefined;
const sinceOf = (cp: Cp) => cp?.updated_at ?? '1970-01-01T00:00:00Z';
const cpOf = (rows: { updated_at: string }[], prev: Cp): Cp =>
  rows.length ? { updated_at: rows[rows.length - 1]!.updated_at } : prev;

/** Quita campos internos de RxDB (_deleted/_meta/_rev/_attachments) y nulls. */
function cleanForPush(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!META.has(k) && v !== null) out[k] = v;
  return out;
}

function replVentas(db: SpikeDB) {
  return replicateRxCollection<VentaDoc, Cp>({
    collection: db.ventas, replicationIdentifier: 'spike-ventas_pos', live: true, retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(cp, limit) {
        const { data, error } = await supa.from('ventas_pos')
          .select('idempotency_uuid,id,tenant_id,local_id,mesa_id,estado,subtotal,total,updated_at')
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
        const payload = rows.map((r) => cleanForPush(r.newDocumentState));
        // eslint-disable-next-line pase-local/no-direct-financiera-write -- SPIKE: HALLAZGO clave — un motor local-first sincroniza escribiendo TABLAS directo, pero el repo manda RPCs atómicas. Reconciliar esto (RPC vs tabla) es decisión central del rebuild. Sandbox descartable.
        const { error } = await supa.from('ventas_pos').upsert(payload, { onConflict: 'idempotency_uuid' });
        if (error) throw error;
        return []; // server-authoritative LWW; sin conflict-detection en el spike
      },
    },
  });
}

function replItems(db: SpikeDB) {
  return replicateRxCollection<ItemDoc, Cp>({
    collection: db.items, replicationIdentifier: 'spike-ventas_pos_items', live: true, retryTime: 5000,
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
          const doc = r.newDocumentState as ItemDoc;
          const ventaId = await resolverVentaId(db, doc.venta_idempotency_uuid);
          // venta_idempotency_uuid SÍ existe en ventas_pos_items → se manda igual.
          // eslint-disable-next-line pase-local/no-direct-financiera-write -- SPIKE: sync local-first via tabla (hallazgo RPC-vs-tabla). Sandbox descartable.
          const { error } = await supa.from('ventas_pos_items')
            .upsert([{ ...cleanForPush(doc), venta_id: ventaId }], { onConflict: 'idempotency_uuid' });
          if (error) throw error;
        }
        return [];
      },
    },
  });
}

function replPagos(db: SpikeDB) {
  return replicateRxCollection<PagoDoc, Cp>({
    collection: db.pagos, replicationIdentifier: 'spike-ventas_pos_pagos', live: true, retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(cp, limit) {
        const { data, error } = await supa.from('ventas_pos_pagos')
          .select('idempotency_uuid,id,venta_id,tenant_id,local_id,metodo,monto,estado,updated_at')
          .gt('updated_at', sinceOf(cp)).not('idempotency_uuid', 'is', null)
          .is('deleted_at', null).order('updated_at', { ascending: true }).limit(limit);
        if (error) throw error;
        // venta_idempotency_uuid NO viene del server (no existe la columna) → vacío.
        const docs = (data ?? []).map((p) => ({ ...(p as Record<string, unknown>), venta_idempotency_uuid: '', _deleted: false })) as WithDeleted<PagoDoc>[];
        return { documents: docs, checkpoint: cpOf(docs, cp) };
      },
    },
    push: {
      batchSize: BATCH,
      async handler(rows) {
        for (const r of rows) {
          const doc = r.newDocumentState as PagoDoc;
          const ventaId = await resolverVentaId(db, doc.venta_idempotency_uuid);
          if (ventaId == null) throw new Error('PAGO_SIN_VENTA_ID'); // padre aún no sincronizado → reintenta
          // HALLAZGO: se quita venta_idempotency_uuid (la col no existe en pagos).
          const clean = cleanForPush(doc);
          delete clean.venta_idempotency_uuid;
          // eslint-disable-next-line pase-local/no-direct-financiera-write -- SPIKE: sync local-first via tabla (hallazgo RPC-vs-tabla). Sandbox descartable.
          const { error } = await supa.from('ventas_pos_pagos').upsert([{ ...clean, venta_id: ventaId }], { onConflict: 'idempotency_uuid' });
          if (error) throw error;
        }
        return [];
      },
    },
  });
}

/** Resuelve el venta_id (bigint server) del padre por su idempotency_uuid. */
async function resolverVentaId(db: SpikeDB, ventaUuid: string): Promise<number | null> {
  const local = await db.ventas.findOne(ventaUuid).exec();
  if (local?.id != null) return local.id;
  const { data } = await supa.from('ventas_pos').select('id').eq('idempotency_uuid', ventaUuid).maybeSingle();
  return (data?.id as number | undefined) ?? null;
}
