// SPIKE — operaciones del flujo contra el store LOCAL (RxDB). Instantáneas por
// construcción: escriben en la copia local, NO esperan red. El sync va aparte.
import type { SpikeDB } from './db';

export interface Ctx { tenant_id: string; local_id: number; }

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Abre una venta/mesa. Devuelve su idempotency_uuid (identidad offline). */
export async function abrirMesa(db: SpikeDB, ctx: Ctx, mesaId: number | null): Promise<string> {
  const u = uuid();
  await db.ventas.insert({
    idempotency_uuid: u, id: null, tenant_id: ctx.tenant_id, local_id: ctx.local_id,
    mesa_id: mesaId, estado: 'abierta', subtotal: 0, total: 0, updated_at: now(),
  });
  return u;
}

/** Agrega un ítem a la venta y recalcula el total. */
export async function agregarItem(
  db: SpikeDB, ctx: Ctx, ventaUuid: string,
  item: { item_id: number; precio_unitario: number; curso: number },
): Promise<void> {
  await db.items.insert({
    idempotency_uuid: uuid(), id: null, venta_idempotency_uuid: ventaUuid,
    tenant_id: ctx.tenant_id, local_id: ctx.local_id, item_id: item.item_id,
    cantidad: 1, precio_unitario: item.precio_unitario, subtotal: item.precio_unitario,
    curso: item.curso, estado: 'nuevo', updated_at: now(),
  });
  await recalcularTotal(db, ventaUuid);
}

/** Registra un pago y marca la venta cobrada. */
export async function cobrar(db: SpikeDB, ctx: Ctx, ventaUuid: string, metodo: string, monto: number): Promise<void> {
  await db.pagos.insert({
    idempotency_uuid: uuid(), id: null, venta_idempotency_uuid: ventaUuid,
    tenant_id: ctx.tenant_id, local_id: ctx.local_id, metodo, monto, estado: 'confirmado', updated_at: now(),
  });
  const venta = await db.ventas.findOne(ventaUuid).exec();
  await venta?.patch({ estado: 'cobrada', updated_at: now() });
}

async function recalcularTotal(db: SpikeDB, ventaUuid: string): Promise<void> {
  const items = await db.items.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
  const total = items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0);
  const venta = await db.ventas.findOne(ventaUuid).exec();
  await venta?.patch({ subtotal: total, total, updated_at: now() });
}
