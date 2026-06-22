// Schemas RxDB del spike — subset REAL de ventas_pos / ventas_pos_items /
// ventas_pos_pagos (introspectado 18-jun).
//
// Identidad offline = `idempotency_uuid` (client-generated), porque el `id`
// real es bigint que asigna el server. Es el mismo patrón del sistema actual
// (fn_resolver_venta_id_por_uuid). Por eso el primaryKey de RxDB es
// `idempotency_uuid`, y `id` (server bigint) queda nullable hasta sincronizar.
//
// HALLAZGO: `ventas_pos_pagos` NO tiene columna `venta_idempotency_uuid`
// (items SÍ). Para linkear un pago offline a una venta aún sin `id`, acá
// guardamos `venta_idempotency_uuid` como campo LOCAL (no existe server-side).
// El rebuild necesita agregar esa columna (origen del bug __pending_parent__).
import type { RxJsonSchema } from 'rxdb';

export interface VentaDoc {
  idempotency_uuid: string;
  id: number | null;            // server bigint, null hasta sync
  tenant_id: string;
  local_id: number;
  canal_id: number;             // requerido por fn_abrir_venta_comanda_offline
  modo: string;                 // requerido (mesa/mostrador/...)
  mesa_id: number | null;
  mozo_id: string | null;
  cajero_id: string | null;
  estado: string;
  subtotal: number;
  total: number;
  updated_at: string;
}

export interface ItemDoc {
  idempotency_uuid: string;
  id: number | null;
  venta_idempotency_uuid: string; // link al padre por uuid (col real existe)
  tenant_id: string;
  local_id: number;
  item_id: number;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  curso: number;
  estado: string;
  updated_at: string;
}

export interface PagoDoc {
  idempotency_uuid: string;
  id: number | null;
  venta_idempotency_uuid: string; // LOCAL: la col NO existe server-side (hallazgo)
  tenant_id: string;
  local_id: number;
  metodo: string;
  monto: number;
  estado: string;
  updated_at: string;
}

export const ventaSchema: RxJsonSchema<VentaDoc> = {
  version: 0, primaryKey: 'idempotency_uuid', type: 'object',
  properties: {
    idempotency_uuid: { type: 'string', maxLength: 64 },
    id: { type: ['number', 'null'] },
    tenant_id: { type: 'string', maxLength: 64 },
    local_id: { type: 'number' },
    canal_id: { type: 'number' },
    modo: { type: 'string' },
    mesa_id: { type: ['number', 'null'] },
    mozo_id: { type: ['string', 'null'] },
    cajero_id: { type: ['string', 'null'] },
    estado: { type: 'string' },
    subtotal: { type: 'number' },
    total: { type: 'number' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['idempotency_uuid', 'tenant_id', 'local_id', 'canal_id', 'modo', 'estado', 'subtotal', 'total', 'updated_at'],
};

export const itemSchema: RxJsonSchema<ItemDoc> = {
  version: 0, primaryKey: 'idempotency_uuid', type: 'object',
  properties: {
    idempotency_uuid: { type: 'string', maxLength: 64 },
    id: { type: ['number', 'null'] },
    venta_idempotency_uuid: { type: 'string', maxLength: 64 },
    tenant_id: { type: 'string', maxLength: 64 },
    local_id: { type: 'number' },
    item_id: { type: 'number' },
    cantidad: { type: 'number' },
    precio_unitario: { type: 'number' },
    subtotal: { type: 'number' },
    curso: { type: 'number' },
    estado: { type: 'string' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['idempotency_uuid', 'venta_idempotency_uuid', 'tenant_id', 'local_id', 'item_id', 'cantidad', 'precio_unitario', 'updated_at'],
};

export const pagoSchema: RxJsonSchema<PagoDoc> = {
  version: 0, primaryKey: 'idempotency_uuid', type: 'object',
  properties: {
    idempotency_uuid: { type: 'string', maxLength: 64 },
    id: { type: ['number', 'null'] },
    venta_idempotency_uuid: { type: 'string', maxLength: 64 },
    tenant_id: { type: 'string', maxLength: 64 },
    local_id: { type: 'number' },
    metodo: { type: 'string' },
    monto: { type: 'number' },
    estado: { type: 'string' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['idempotency_uuid', 'venta_idempotency_uuid', 'tenant_id', 'local_id', 'metodo', 'monto', 'updated_at'],
};

// Outbox de OPERACIONES (Fase 2): acciones que MODIFICAN una venta existente
// (anular, descuento, cortesía, mandar curso, mesa-ops). El flujo de Fase 1 solo
// CREA (venta/item/pago); estas modificaciones se encolan acá y el sync las
// empuja en orden vía su RPC `_offline` (que resuelve el padre por uuid).
// payload = params extra de la RPC (sin p_venta_id / p_venta_idempotency_uuid,
// que los agrega el push) guardados como JSON (RxDB no quiere objetos libres).
export interface OpDoc {
  idempotency_uuid: string;        // PK = id de la operación
  rpc: string;                     // ej 'fn_anular_venta_comanda_offline'
  venta_idempotency_uuid: string;  // venta sobre la que opera (resuelve p_venta_id)
  payload_json: string;            // JSON.stringify de los params extra
  done: boolean;                   // false hasta que el sync la empuja OK
  updated_at: string;
}

export const opSchema: RxJsonSchema<OpDoc> = {
  version: 0, primaryKey: 'idempotency_uuid', type: 'object',
  properties: {
    idempotency_uuid: { type: 'string', maxLength: 64 },
    rpc: { type: 'string', maxLength: 80 },
    venta_idempotency_uuid: { type: 'string', maxLength: 64 },
    payload_json: { type: 'string' },
    done: { type: 'boolean' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['idempotency_uuid', 'rpc', 'venta_idempotency_uuid', 'payload_json', 'done', 'updated_at'],
};
