// Migrations del schema local IndexedDB.
//
// Cada migration corresponde a una versión del DB schema. Se ejecutan en
// orden en `upgrade()` cuando se abre la DB y la versión local del cliente
// es menor que `DB_VERSION`.
//
// REGLAS:
//   1. NUNCA modificar una migration ya publicada. Crear una nueva siempre.
//   2. NUNCA bajar DB_VERSION. IndexedDB no soporta downgrade.
//   3. Cada migration es idempotente — si se ejecuta en una DB ya migrada,
//      no debe romper (chequear con `if (!db.objectStoreNames.contains(...))`).
//   4. Si una migration agrega un índice, también tenés que considerar
//      cómo backfillar las filas existentes.

import type { IDBPDatabase, IDBPTransaction } from 'idb';

// Tipo del callback `upgrade` de openDB con todos los parámetros necesarios.
// Lo declaramos acá para no repetirlo en cada migration.
type UpgradeCtx = {
  db: IDBPDatabase;
  oldVersion: number;
  newVersion: number | null;
  transaction: IDBPTransaction<unknown, string[], 'versionchange'>;
};

// ─── Migration v1 — schema inicial ──────────────────────────────────────────
// Crea todos los object stores definidos en STORES + sus índices.
function migrateToV1(ctx: UpgradeCtx) {
  const { db } = ctx;

  // ── items ──
  // keyPath = 'id' (BIGINT serial del cloud por ahora; cuando Fase 3 lleguen
  // los UUIDs, este campo sigue siendo 'id' — el tipo cambia transparente).
  if (!db.objectStoreNames.contains('items')) {
    const store = db.createObjectStore('items', { keyPath: 'id' });
    store.createIndex('by_tenant', 'tenant_id');
    store.createIndex('by_grupo', 'grupo_id');
    store.createIndex('by_dirty', '_local_dirty');
  }

  // ── item_grupos ──
  if (!db.objectStoreNames.contains('item_grupos')) {
    const store = db.createObjectStore('item_grupos', { keyPath: 'id' });
    store.createIndex('by_tenant', 'tenant_id');
    store.createIndex('by_orden', 'orden');
  }

  // ── mesas ──
  if (!db.objectStoreNames.contains('mesas')) {
    const store = db.createObjectStore('mesas', { keyPath: 'id' });
    store.createIndex('by_local', 'local_id');
    store.createIndex('by_zona', 'zona');
    store.createIndex('by_dirty', '_local_dirty');
  }

  // ── canales ──
  if (!db.objectStoreNames.contains('canales')) {
    const store = db.createObjectStore('canales', { keyPath: 'id' });
    store.createIndex('by_tenant', 'tenant_id');
    store.createIndex('by_slug', 'slug');
  }

  // ── empleados ──
  // Empleados POS activos del local actual. UUID en `id` (rrhh_empleados.id
  // ya es UUID en el cloud).
  if (!db.objectStoreNames.contains('empleados')) {
    const store = db.createObjectStore('empleados', { keyPath: 'id' });
    store.createIndex('by_local', 'local_id');
  }

  // ── ventas_pos ──
  // CRÍTICA: cada venta abierta offline genera id local provisional. Cuando
  // se sincroniza, el server le asigna el id real. El repo maneja esa
  // reconciliación. Por ahora keyPath = 'id'.
  if (!db.objectStoreNames.contains('ventas_pos')) {
    const store = db.createObjectStore('ventas_pos', { keyPath: 'id' });
    store.createIndex('by_local', 'local_id');
    store.createIndex('by_mesa', 'mesa_id');
    store.createIndex('by_estado', 'estado');
    store.createIndex('by_dirty', '_local_dirty');
    store.createIndex('by_abierta_at', 'abierta_at');
  }

  // ── ventas_pos_items ──
  if (!db.objectStoreNames.contains('ventas_pos_items')) {
    const store = db.createObjectStore('ventas_pos_items', { keyPath: 'id' });
    store.createIndex('by_venta', 'venta_id');
    store.createIndex('by_estado', 'estado');
    store.createIndex('by_dirty', '_local_dirty');
  }

  // ── ventas_pos_pagos ──
  if (!db.objectStoreNames.contains('ventas_pos_pagos')) {
    const store = db.createObjectStore('ventas_pos_pagos', { keyPath: 'id' });
    store.createIndex('by_venta', 'venta_id');
    store.createIndex('by_dirty', '_local_dirty');
  }

  // ── sync_meta ──
  // 1 fila por (store, scope). keyPath compuesto: `${store}:${scope}`.
  // El repo encapsula esto, no hace falta exponerlo afuera.
  if (!db.objectStoreNames.contains('sync_meta')) {
    db.createObjectStore('sync_meta', { keyPath: 'pk' });
  }

  // ── pending_ops ──
  // Cola FIFO de operaciones pendientes de push al cloud.
  if (!db.objectStoreNames.contains('pending_ops')) {
    const store = db.createObjectStore('pending_ops', { keyPath: 'id' });
    store.createIndex('by_status', 'status');
    store.createIndex('by_created_at', 'created_at');
    store.createIndex('by_target', 'target');
  }

  // ── sync_conflicts ──
  if (!db.objectStoreNames.contains('sync_conflicts')) {
    const store = db.createObjectStore('sync_conflicts', { keyPath: 'id' });
    store.createIndex('by_resolution', 'resolution');
    store.createIndex('by_detected_at', 'detected_at');
  }
}

// Lista ordenada de migrations. Cuando el cliente abre la DB con versión
// vieja, ejecuta TODAS las migrations desde oldVersion+1 hasta DB_VERSION.
export const MIGRATIONS: Array<{ version: number; run: (ctx: UpgradeCtx) => void }> = [
  { version: 1, run: migrateToV1 },
];

// Hook principal que se le pasa a openDB. Itera sobre las migrations
// pendientes y las aplica en orden.
export function runMigrations(ctx: UpgradeCtx) {
  for (const m of MIGRATIONS) {
    if (m.version > ctx.oldVersion) {
      m.run(ctx);
    }
  }
}
