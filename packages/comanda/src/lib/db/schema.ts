// Schema de la DB local (IndexedDB) para COMANDA offline-first.
//
// Cada object store es la réplica local de una tabla de Supabase. Los tipos
// extienden los tipos canónicos de types/database.ts pero agregan metadata
// de sync (campos `_local_*`) que SOLO viven local — nunca se mandan al
// cloud.
//
// Versionado: incrementar DB_VERSION + agregar paso en migrations.ts cuando
// cambie el shape. NUNCA modificar una migration ya publicada.
//
// IMPORTANTE: este archivo es la fuente de verdad del shape local. Si
// agregás un campo nuevo, también tenés que:
//   1. Actualizar la migration correspondiente (o crear una nueva).
//   2. Actualizar el repo si querés exponerlo.
//   3. Actualizar el sync engine (Fase 2) para incluirlo en pull/push.

import type {
  Item, ItemGrupo, Mesa, Canal, EmpleadoPos,
  VentaPos, VentaPosItem, VentaPosPago,
} from '../../types/database';

// Versión actual del schema local. Incrementar al agregar/modificar stores.
// Cada vez que sube, migrations.ts ejecuta el upgrade correspondiente al
// abrir la DB en cada device. NO bajar nunca (downgrade no soportado).
export const DB_VERSION = 1;
export const DB_NAME = 'comanda-local';

// ─── Metadata por fila (campos privados locales) ────────────────────────────
// Todos los registros locales llevan estos campos. Sirven para que el sync
// engine sepa qué push/pull. No se persisten en Supabase.
//
//   _local_dirty   true = hay cambios sin sincronizar al cloud
//   _local_op      última operación local (insert/update/delete)
//   _local_synced_at  última vez que se confirmó sincronizado
//   _local_origin  device que generó el record (UUID device)
//   _local_op_id   id de la PendingOp que creó este record (para depends_on
//                  de ops dependientes — ej. item depende de su venta padre)
export interface LocalMeta {
  _local_dirty?: boolean;
  _local_op?: 'insert' | 'update' | 'delete';
  _local_synced_at?: string | null;
  _local_origin?: string;
  _local_op_id?: string;
}

// ─── Tipos por store ────────────────────────────────────────────────────────
// Cada store define su tipo (registro almacenado) + key (campo `keyPath`).
// Los tipos cloud-side ya existen en types/database.ts — los reusamos con
// LocalMeta intersection.

export type LocalItem        = Item & LocalMeta;
export type LocalItemGrupo   = ItemGrupo & LocalMeta;
export type LocalMesa        = Mesa & LocalMeta;
export type LocalCanal       = Canal & LocalMeta;
export type LocalEmpleado    = EmpleadoPos & LocalMeta;
export type LocalVentaPos    = VentaPos & LocalMeta;
export type LocalVentaItem   = VentaPosItem & LocalMeta;
export type LocalVentaPago   = VentaPosPago & LocalMeta;

// Sync metadata global: una fila por tabla cacheada que indica cuándo fue
// el último pull (para pull incremental en Fase 2).
export interface SyncMeta {
  store: StoreName;
  last_pull_at: string | null;
  last_full_sync_at: string | null;
  // Scope: tenant_id + local_id para que pulls por local no se confundan
  // si el usuario cambia de local activo en la sesión.
  scope: string;
}

// Cola de operaciones pendientes de push al cloud. Persiste entre sesiones
// para que un corte largo de internet no pierda operaciones.
//
// `id` es un UUID generado client-side al crear la operación. Sirve como
// idempotency_key — si el push falla y se retry, el server-side debe
// detectar el id repetido y no duplicar.
export type PendingOpType = 'insert' | 'update' | 'delete' | 'rpc';
export type PendingOpStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface PendingOp {
  id: string;                      // UUID generado client-side, idempotency key
  created_at: string;
  op_type: PendingOpType;
  // Para insert/update/delete: nombre de la tabla. Para rpc: nombre de la fn.
  target: string;
  // Payload depende del op_type:
  //   insert/update: row completa o patch
  //   delete: { id }
  //   rpc: argumentos de la RPC
  payload: unknown;
  // Para FKs encadenadas: si esta op depende de otra (ej. agregar item a una
  // venta recién abierta offline), el `depends_on` referencia el id de la op
  // padre. El sync engine respeta el orden.
  depends_on?: string | null;
  status: PendingOpStatus;
  retries: number;
  last_attempt_at?: string | null;
  last_error?: string | null;

  // Resultado retornado por el server al ejecutar la op exitosamente.
  // Para RPCs `_offline` que devuelven el BIGINT real asignado, sirve para
  // reconciliar el tempId negativo local con el id real.
  // Sync engine lo setea al transicionar status='synced'.
  server_result?: unknown;

  // Hint de qué tipo de reconciliación hacer al estar `synced`. Ej:
  //   { kind: 'venta', tempVentaId: -1234567890 }
  // El idReconciliation.ts lo consume.
  reconcile?: ReconcileHint | null;
}

// Hint de reconciliación de tempId → BIGINT real. Cuando una op offline
// crea un row local con tempId negativo, este hint le dice al engine qué
// row local actualizar cuando el server retorne el BIGINT real.
export type ReconcileHint =
  | { kind: 'venta'; tempVentaId: number }
  | { kind: 'venta_item'; tempItemId: number; tempVentaId: number | null }
  | { kind: 'venta_pago'; tempPagoId: number; tempVentaId: number | null }
  | { kind: 'none' };

// Log de conflictos de sync auto-resueltos (LWW) o pendientes de resolución
// manual. Útil para auditoría y para que un manager revise conflictos raros
// al final del turno.
export interface SyncConflict {
  id: string;                      // UUID
  detected_at: string;
  store: string;
  row_id: string;                  // id de la fila en conflicto
  // local vs cloud: snapshot de ambos al momento del conflicto.
  local_value: unknown;
  cloud_value: unknown;
  resolution: 'local_wins' | 'cloud_wins' | 'manual_pending' | 'manual_resolved';
  resolved_by?: string;            // empleado_id si manual
  resolved_at?: string;
  note?: string;
}

// ─── Lista de stores (object stores en IndexedDB) ──────────────────────────
// Constante para usar como type-safe identifier. Cualquier código que abre
// transactions usa esta lista.
export const STORES = [
  'items',
  'item_grupos',
  'mesas',
  'canales',
  'empleados',
  'ventas_pos',
  'ventas_pos_items',
  'ventas_pos_pagos',
  'sync_meta',
  'pending_ops',
  'sync_conflicts',
] as const;

export type StoreName = (typeof STORES)[number];

// Mapping store → tipo del registro. Usado por BaseRepository para tipar
// los métodos genéricos.
export interface StoreTypes {
  items:              LocalItem;
  item_grupos:        LocalItemGrupo;
  mesas:              LocalMesa;
  canales:            LocalCanal;
  empleados:          LocalEmpleado;
  ventas_pos:         LocalVentaPos;
  ventas_pos_items:   LocalVentaItem;
  ventas_pos_pagos:   LocalVentaPago;
  sync_meta:          SyncMeta;
  pending_ops:        PendingOp;
  sync_conflicts:     SyncConflict;
}
