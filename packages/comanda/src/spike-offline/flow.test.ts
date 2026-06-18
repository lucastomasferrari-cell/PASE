// SPIKE — prueba que el flujo corre 100% sobre el store LOCAL, sin red:
// abrir → agregar → cobrar, instantáneo y consistente. Storage en memoria
// (Node no tiene IndexedDB).
import { describe, it, expect, afterEach } from 'vitest';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { crearSpikeDB, type SpikeDB } from './db';
import { abrirMesa, agregarItem, cobrar } from './flow';

const ctx = { tenant_id: 'test-tenant', local_id: 2 };

describe('spike offline flow (local-only, sin red)', () => {
  let db: SpikeDB | null = null;
  afterEach(async () => { await db?.remove(); db = null; });

  it('abrir → agregar → cobrar funciona sobre el store local', async () => {
    db = await crearSpikeDB(`spike-test-${crypto.randomUUID().slice(0, 8)}`, getRxStorageMemory());

    const ventaUuid = await abrirMesa(db, ctx, 1);
    expect(ventaUuid).toBeTruthy();

    await agregarItem(db, ctx, ventaUuid, { item_id: 1, precio_unitario: 5000, curso: 1 });
    await agregarItem(db, ctx, ventaUuid, { item_id: 2, precio_unitario: 7000, curso: 1 });

    const venta = await db.ventas.findOne(ventaUuid).exec();
    expect(venta?.total).toBe(12000);
    expect(venta?.estado).toBe('abierta');

    await cobrar(db, ctx, ventaUuid, 'efectivo', 12000);

    const cobrada = await db.ventas.findOne(ventaUuid).exec();
    expect(cobrada?.estado).toBe('cobrada');

    const items = await db.items.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(items.length).toBe(2);
    const pagos = await db.pagos.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(pagos.length).toBe(1);
    expect(pagos[0]?.monto).toBe(12000);
  });
});
