// offline2 — operaciones del flujo central contra el store LOCAL (RxDB).
// Instantáneas por construcción: escriben la copia local, NO esperan red. El
// sync (sync.ts) las empuja a Supabase vía las RPCs `_offline` en background.
// Este es el corazón de la UI optimista estilo Toast: el toque nunca espera red.
import type { OfflineDB } from './db';

export interface Ctx {
  tenant_id: string;
  local_id: number;
  canal_id: number;            // requerido por fn_abrir_venta_comanda_offline
  modo: string;                // mesa/mostrador/...
  mozo_id?: string | null;
  cajero_id?: string | null;
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Abre una venta/mesa. Devuelve su idempotency_uuid (identidad offline). */
export async function abrirMesa(db: OfflineDB, ctx: Ctx, mesaId: number | null): Promise<string> {
  const u = uuid();
  await db.ventas.insert({
    idempotency_uuid: u, id: null, tenant_id: ctx.tenant_id, local_id: ctx.local_id,
    canal_id: ctx.canal_id, modo: ctx.modo, mesa_id: mesaId,
    mozo_id: ctx.mozo_id ?? null, cajero_id: ctx.cajero_id ?? null,
    estado: 'abierta', subtotal: 0, total: 0, updated_at: now(),
  });
  return u;
}

/** Agrega un ítem a la venta y recalcula el total. */
export async function agregarItem(
  db: OfflineDB, ctx: Ctx, ventaUuid: string,
  item: { item_id: number; precio_unitario: number; curso?: number; cantidad?: number },
): Promise<string> {
  const u = uuid();
  const cantidad = item.cantidad ?? 1;
  await db.items.insert({
    idempotency_uuid: u, id: null, venta_idempotency_uuid: ventaUuid,
    tenant_id: ctx.tenant_id, local_id: ctx.local_id, item_id: item.item_id,
    cantidad, precio_unitario: item.precio_unitario, subtotal: item.precio_unitario * cantidad,
    curso: item.curso ?? 1, estado: 'nuevo', updated_at: now(),
  });
  await recalcularTotal(db, ventaUuid);
  return u;
}

/** Registra un pago y marca la venta cobrada. Devuelve el uuid del pago. */
export async function cobrar(
  db: OfflineDB, ctx: Ctx, ventaUuid: string, metodo: string, monto: number,
): Promise<string> {
  const u = uuid();
  await db.pagos.insert({
    idempotency_uuid: u, id: null, venta_idempotency_uuid: ventaUuid,
    tenant_id: ctx.tenant_id, local_id: ctx.local_id, metodo, monto,
    estado: 'confirmado', updated_at: now(),
  });
  const venta = await db.ventas.findOne(ventaUuid).exec();
  await venta?.patch({ estado: 'cobrada', updated_at: now() });
  return u;
}

/** Recalcula subtotal/total de una venta desde sus ítems locales. */
export async function recalcularTotal(db: OfflineDB, ventaUuid: string): Promise<void> {
  const items = await db.items.find({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
  const total = items.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0);
  const venta = await db.ventas.findOne(ventaUuid).exec();
  await venta?.patch({ subtotal: total, total, updated_at: now() });
}
