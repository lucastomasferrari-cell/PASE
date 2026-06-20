// offline2 — bridge entre los services (mundo id-numérico + tipos VentaPos) y
// el motor local (uuid + RxDB). Las pantallas no cambian: siguen llamando a los
// services con tempIds negativos; acá traducimos a/desde el store local.
//
// Los services son funciones planas (no React) → obtienen el store vía el
// singleton crearOfflineDB() (la MISMA instancia que el OfflineProvider creó y
// que el sync está empujando).
import type { VentaPos, VentaPosItem, ModoVenta, EstadoVenta, EstadoVentaItem } from '@/types/database';
import { crearOfflineDB } from './db';
import { abrirMesa, agregarItem as repoAgregarItem, agregarPago, marcarVentaCobrada } from './repos';
import { uuidToTempId } from './tempId';
import type { VentaDoc, ItemDoc } from './schema';
import type { OfflineDB } from './db';

// ── Resolución tempId → uuid (escaneo determinístico, sobrevive recargas) ─────
async function resolveUuid(db: OfflineDB, tempId: number): Promise<string | null> {
  const ventas = await db.ventas.find().exec();
  for (const v of ventas) {
    if (uuidToTempId(v.idempotency_uuid) === tempId) return v.idempotency_uuid;
  }
  return null;
}

// ── Mappers doc → tipo de pantalla ────────────────────────────────────────────
function ventaDocToVentaPos(d: VentaDoc, tempId: number): VentaPos {
  const cobrada = d.estado === 'cobrada';
  return {
    id: tempId, // numérico negativo (la pantalla rutea por esto)
    tenant_id: d.tenant_id, local_id: d.local_id,
    created_at: d.updated_at, updated_at: d.updated_at, deleted_at: null,
    numero_local: 0, // placeholder hasta que sincronice (lo asigna el server)
    modo: d.modo as ModoVenta, canal_id: d.canal_id, turno_caja_id: null,
    mesa_id: d.mesa_id, comensales: null, mozo_id: d.mozo_id, cajero_id: d.cajero_id,
    cliente_nombre: null, cliente_telefono: null, cliente_direccion: null, covers: null,
    estado: d.estado as EstadoVenta, origen: 'pos', programada_para: null, tipo_entrega: null,
    subtotal: d.subtotal, descuento_total: 0, propina: 0, total: d.total,
    abierta_at: d.updated_at, enviada_at: null, cobrada_at: cobrada ? d.updated_at : null,
    anulada_at: null, notas: null, cobro_idempotency_key: null,
    idempotency_uuid: d.idempotency_uuid,
  };
}

function itemDocToVentaPosItem(d: ItemDoc, ventaTempId: number): VentaPosItem {
  return {
    id: uuidToTempId(d.idempotency_uuid), tenant_id: d.tenant_id, local_id: d.local_id,
    venta_id: ventaTempId, item_id: d.item_id, cantidad: d.cantidad,
    precio_unitario: d.precio_unitario, subtotal: d.subtotal, descuento: 0,
    modificadores: null, curso: d.curso, comensal: null, combo_padre_id: null,
    es_combo_padre: false, estado: d.estado as EstadoVentaItem,
    enviado_at: null, listo_at: null, anulado_at: null, anulado_motivo: null,
    notas: null, cargado_por: null,
    created_at: d.updated_at, updated_at: d.updated_at, deleted_at: null,
  };
}

// ── API que consumen los services ─────────────────────────────────────────────

export interface AbrirVentaLocalArgs {
  localId: number; canalId: number; modo: string;
  mesaId?: number | null; mozoId?: string | null; cajeroId?: string | null;
}

/** Abre una venta en el store local. Devuelve el tempId negativo para la UI. */
export async function abrirVentaLocal(a: AbrirVentaLocalArgs): Promise<number> {
  const db = await crearOfflineDB();
  // tenant_id local = '' : el server lo deriva de auth_tenant_id() al sincronizar.
  const uuid = await abrirMesa(
    db,
    { tenant_id: '', local_id: a.localId, canal_id: a.canalId, modo: a.modo, mozo_id: a.mozoId ?? null, cajero_id: a.cajeroId ?? null },
    a.mesaId ?? null,
  );
  return uuidToTempId(uuid);
}

/** Lee una venta local por tempId. null si no existe (no es local). */
export async function getVentaLocal(tempId: number): Promise<VentaPos | null> {
  const db = await crearOfflineDB();
  const uuid = await resolveUuid(db, tempId);
  if (!uuid) return null;
  const v = await db.ventas.findOne(uuid).exec();
  return v ? ventaDocToVentaPos(v.toJSON() as VentaDoc, tempId) : null;
}

/** Lista los ítems de una venta local, ordenados curso ASC → id ASC. */
export async function listItemsLocal(tempId: number): Promise<VentaPosItem[]> {
  const db = await crearOfflineDB();
  const uuid = await resolveUuid(db, tempId);
  if (!uuid) return [];
  const items = await db.items.find({ selector: { venta_idempotency_uuid: uuid } }).exec();
  return items
    .map((it) => itemDocToVentaPosItem(it.toJSON() as ItemDoc, tempId))
    .sort((a, b) => {
      const ca = a.curso ?? Number.MAX_SAFE_INTEGER;
      const cb = b.curso ?? Number.MAX_SAFE_INTEGER;
      return ca !== cb ? ca - cb : a.id - b.id;
    });
}

/** Agrega un ítem a una venta local. Devuelve el tempId del ítem (o null). */
export async function agregarItemLocal(
  tempId: number,
  item: { itemId: number; cantidad: number; precioUnitario: number; curso?: number },
): Promise<number | null> {
  const db = await crearOfflineDB();
  const uuid = await resolveUuid(db, tempId);
  if (!uuid) return null;
  const v = await db.ventas.findOne(uuid).exec();
  if (!v) return null;
  const ctx = { tenant_id: v.tenant_id, local_id: v.local_id, canal_id: v.canal_id, modo: v.modo };
  const itemUuid = await repoAgregarItem(db, ctx, uuid, {
    item_id: item.itemId, precio_unitario: item.precioUnitario, curso: item.curso ?? 1, cantidad: item.cantidad,
  });
  return uuidToTempId(itemUuid);
}

/** Cobra una venta local (uno o varios pagos) y la marca cobrada. */
export async function cobrarLocal(
  tempId: number, pagos: { metodo: string; monto: number }[],
): Promise<{ total: number; error: string | null }> {
  const db = await crearOfflineDB();
  const uuid = await resolveUuid(db, tempId);
  if (!uuid) return { total: 0, error: 'VENTA_LOCAL_NO_ENCONTRADA' };
  const v = await db.ventas.findOne(uuid).exec();
  if (!v) return { total: 0, error: 'VENTA_LOCAL_NO_ENCONTRADA' };
  const ctx = { tenant_id: v.tenant_id, local_id: v.local_id, canal_id: v.canal_id, modo: v.modo };
  let total = 0;
  for (const p of pagos) {
    await agregarPago(db, ctx, uuid, p.metodo, p.monto);
    total += p.monto;
  }
  await marcarVentaCobrada(db, uuid);
  return { total, error: null };
}
