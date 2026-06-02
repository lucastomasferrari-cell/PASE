// cleanup — helper para limpiar el state offline cuando algo queda trabado.
//
// Casos donde hace falta:
//   - Ops pendientes que fallan en loop (RPC server cambió signature, etc.)
//   - Ventas zombies con id temp negativo que no sincronizan
//   - User reporta "11 pendientes" o errores 400 repetidos en consola
//
// Se expone como `window.__comandaCleanupOffline()` para que Lucas/Anto
// puedan ejecutarlo desde la consola del browser sin necesidad de un
// botón en la UI. Es operación destructiva — borra IDB + recarga.
//
// Sprint offline-first cierre (2026-06-02).

export interface CleanupResult {
  pending_ops_borradas: number;
  ventas_zombies_borradas: number;
  items_zombies_borrados: number;
}

/**
 * Borra TODAS las pending_ops, ventas con id negativo (no sincronizadas)
 * y sus items. No toca ventas con id positivo (ya sincronizadas).
 *
 * NO recarga la página — el caller decide. En la versión "nuclear" que
 * exponemos en window, sí recargamos.
 */
export async function cleanupOfflineState(): Promise<CleanupResult> {
  const { getDb } = await import('./index');
  const db = await getDb();

  const result: CleanupResult = {
    pending_ops_borradas: 0,
    ventas_zombies_borradas: 0,
    items_zombies_borrados: 0,
  };

  // 1. Borrar todas las pending_ops (status pendiente/syncing/failed)
  const txOps = db.transaction('pending_ops', 'readwrite');
  let cursor = await txOps.store.openCursor();
  while (cursor) {
    await cursor.delete();
    result.pending_ops_borradas++;
    cursor = await cursor.continue();
  }
  await txOps.done;

  // 2. Borrar ventas con id negativo (no sincronizadas)
  const txVentas = db.transaction('ventas_pos', 'readwrite');
  let cursorV = await txVentas.store.openCursor();
  const ventasNegativasIds: number[] = [];
  while (cursorV) {
    const row = cursorV.value as { id: number };
    if (row.id < 0) {
      ventasNegativasIds.push(row.id);
      await cursorV.delete();
      result.ventas_zombies_borradas++;
    }
    cursorV = await cursorV.continue();
  }
  await txVentas.done;

  // 3. Borrar items que pertenecían a las ventas zombies
  if (ventasNegativasIds.length > 0) {
    const txItems = db.transaction('ventas_pos_items', 'readwrite');
    const idx = txItems.store.index('by_venta');
    for (const ventaId of ventasNegativasIds) {
      let cursorI = await idx.openCursor(ventaId);
      while (cursorI) {
        await cursorI.delete();
        result.items_zombies_borrados++;
        cursorI = await cursorI.continue();
      }
    }
    await txItems.done;
  }

  // 4. También borrar items con venta_id negativo que pudieran haber
  //    quedado huérfanos por alguna razón
  const txItemsOrph = db.transaction('ventas_pos_items', 'readwrite');
  let cursorIO = await txItemsOrph.store.openCursor();
  while (cursorIO) {
    const row = cursorIO.value as { venta_id: number };
    if (row.venta_id < 0) {
      await cursorIO.delete();
      result.items_zombies_borrados++;
    }
    cursorIO = await cursorIO.continue();
  }
  await txItemsOrph.done;

  return result;
}

/**
 * Versión "nuclear": borra IDB entero + recarga. Para casos donde el
 * cleanup parcial no alcanza (schema corrupto, índices rotos, etc.).
 *
 * Equivale a:
 *   indexedDB.deleteDatabase('comanda-offline-db');
 *   location.reload();
 */
export function cleanupOfflineNuclear(): void {
  if (typeof indexedDB === 'undefined') return;
  // Cerrar conexiones abiertas primero
  try {
    void indexedDB.deleteDatabase('comanda-offline');
    void indexedDB.deleteDatabase('comanda-offline-db');
  } catch {
    /* silent */
  }
  if (typeof window !== 'undefined') {
    setTimeout(() => window.location.reload(), 500);
  }
}

// Exponer en window para uso desde consola del browser.
// Lucas: en F12 consola, ejecutar:
//   await __comandaCleanupOffline()           // limpieza selectiva (deja DB)
//   __comandaCleanupOfflineNuclear()          // borra DB entera + reload
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__comandaCleanupOffline = async () => {
    const result = await cleanupOfflineState();
    console.log('[cleanup offline]', result);
    if (result.pending_ops_borradas > 0 || result.ventas_zombies_borradas > 0) {
      console.log('[cleanup offline] Recargando para aplicar...');
      setTimeout(() => window.location.reload(), 1000);
    } else {
      console.log('[cleanup offline] No había nada que limpiar.');
    }
    return result;
  };
  (window as unknown as Record<string, unknown>).__comandaCleanupOfflineNuclear = cleanupOfflineNuclear;
}
