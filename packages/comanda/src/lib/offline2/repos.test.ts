// offline2 — el flujo central corre 100% sobre el store LOCAL, sin red:
// abrir → agregar → cobrar, instantáneo y consistente. Storage en memoria
// (Node no tiene IndexedDB).
import { describe, it, expect, afterEach } from 'vitest';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { crearOfflineDB, type OfflineDB } from './db';
import { abrirMesa, agregarItem, cobrar } from './repos';

const ctx = { tenant_id: 'test-tenant', local_id: 2, canal_id: 1, modo: 'mesa' };

describe('offline2 repos (local-only, sin red)', () => {
  let db: OfflineDB | null = null;
  afterEach(async () => { await db?.remove(); db = null; });

  it('abrir → agregar → cobrar funciona sobre el store local', async () => {
    db = await crearOfflineDB(`o2-test-${crypto.randomUUID().slice(0, 8)}`, getRxStorageMemory());

    const ventaUuid = await abrirMesa(db, ctx, 1);
    expect(ventaUuid).toBeTruthy();

    await agregarItem(db, ctx, ventaUuid, { item_id: 1, precio_unitario: 5000, curso: 1 });
    await agregarItem(db, ctx, ventaUuid, { item_id: 2, precio_unitario: 7000, curso: 1, cantidad: 2 });

    const venta = await db.ventas.findOne(ventaUuid).exec();
    expect(venta?.total).toBe(19000); // 5000 + 7000*2
    expect(venta?.estado).toBe('abierta');
    expect(venta?.id).toBeNull();      // aún sin sync → id server null

    await cobrar(db, ctx, ventaUuid, 'efectivo', 19000);

    const cobrada = await db.ventas.findOne(ventaUuid).exec();
    expect(cobrada?.estado).toBe('cobrada');

    const items = await db.items.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(items.length).toBe(2);
    const pagos = await db.pagos.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(pagos.length).toBe(1);
    expect(pagos[0]?.monto).toBe(19000);
  });
});
