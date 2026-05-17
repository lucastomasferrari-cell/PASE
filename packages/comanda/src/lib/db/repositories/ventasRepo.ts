// Repository de ventas_pos + items + pagos.
//
// Las ventas son el core operativo del POS. Operaciones críticas:
//   - abrirVenta: insert nueva con UUID provisional + queue push
//   - agregarItem: insert item local + recalcular total + queue push
//   - mandarCurso: update items + queue push (en Fase 4)
//   - cobrarVenta: insert pagos + mark venta cobrada + queue push

import { BaseRepository } from './base';
import type { LocalVentaPos, LocalVentaItem, LocalVentaPago } from '../schema';
import { getDb } from '../index';

// Estados de venta que cuentan como "abierta" (mostrar en salón, no cobrada).
const ABIERTA_STATES = new Set(['abierta', 'enviada', 'lista', 'entregada']);

class VentasRepository extends BaseRepository<'ventas_pos'> {
  constructor() {
    super('ventas_pos');
  }

  async listByLocal(localId: number, opts: { soloAbiertas?: boolean } = {}): Promise<LocalVentaPos[]> {
    const all = await this.findByIndex('by_local', localId);
    let filtered = all.filter((v) => !v.deleted_at);
    if (opts.soloAbiertas) {
      filtered = filtered.filter((v) => ABIERTA_STATES.has(v.estado));
    }
    return filtered.sort((a, b) => {
      const da = a.abierta_at ?? '';
      const db = b.abierta_at ?? '';
      return db.localeCompare(da);
    });
  }

  async listAbiertasByLocal(localId: number): Promise<LocalVentaPos[]> {
    return this.listByLocal(localId, { soloAbiertas: true });
  }

  async findByMesa(mesaId: number): Promise<LocalVentaPos | undefined> {
    const all = await this.findByIndex('by_mesa', mesaId);
    return all.find((v) => !v.deleted_at && ABIERTA_STATES.has(v.estado));
  }
}

class VentasItemsRepository extends BaseRepository<'ventas_pos_items'> {
  constructor() {
    super('ventas_pos_items');
  }

  async listByVenta(ventaId: number): Promise<LocalVentaItem[]> {
    const all = await this.findByIndex('by_venta', ventaId);
    return all
      .filter((i) => !i.deleted_at)
      .sort((a, b) => a.id - b.id);
  }

  // Borra todos los items de una venta. Usado cuando una venta se anula
  // por completo o cuando llega un pull con shape distinto al local.
  async deleteByVenta(ventaId: number): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('ventas_pos_items', 'readwrite');
    const index = tx.store.index('by_venta');
    let cursor = await index.openCursor(ventaId);
    while (cursor) {
      await cursor!.delete();
      cursor = await cursor!.continue();
    }
    await tx.done;
  }
}

class VentasPagosRepository extends BaseRepository<'ventas_pos_pagos'> {
  constructor() {
    super('ventas_pos_pagos');
  }

  async listByVenta(ventaId: number): Promise<LocalVentaPago[]> {
    // VentaPosPago no tiene soft-delete (deleted_at) — los pagos anulados
    // se marcan via venta.estado='anulada' o override aparte. Devolvemos todo.
    return this.findByIndex('by_venta', ventaId);
  }
}

export const ventasRepo = new VentasRepository();
export const ventasItemsRepo = new VentasItemsRepository();
export const ventasPagosRepo = new VentasPagosRepository();
