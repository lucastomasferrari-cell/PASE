import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { createDuenoClient } from './helpers/supabaseClient';
import { crearOfflineDB, type OfflineDB } from '../src/lib/offline2/db';
import { abrirMesa, agregarItem, cobrar } from '../src/lib/offline2/repos';
import { flushPending, callAbrir } from '../src/lib/offline2/sync';
import type { VentaDoc } from '../src/lib/offline2/schema';

// offline2 — ciclo offline → sync (rebuild estilo Toast, 2026-06-18).
// Prueba el corazón del rebuild: el flujo corre 100% local (RxDB, sin red) y
// luego el push lo materializa en Supabase VÍA LAS RPCs `_offline` (no upsert
// crudo), con el id bigint reconciliado y sin duplicados.
//
// Invariantes:
//   1. abrir → agregar → cobrar corre sobre el store local (ids server null).
//   2. flushPending() empuja vía las RPCs → venta+item+pago en Supabase, con el
//      id reconciliado en el doc local (cierra el ciclo uuid→id).
//   3. La venta queda 'cobrada' y el pago 'confirmado' (el pago cubre el total).
//   4. Idempotencia: re-pushear la venta (mismo idempotency_uuid) devuelve el
//      MISMO id y NO duplica filas (las RPCs dedup por uuid).
//
// NOTA (gap Fase 2): la venta offline no lleva turno_caja_id → el cobro NO
// genera movimientos_caja. Asociar turno al sincronizar es trabajo de Fase 2.

const LOCAL = 'Local Prueba 2';
const PRECIO = 4500;

test.describe('offline2 ciclo offline→sync (mutante)', () => {
  let supa: SupabaseClient;
  let db: OfflineDB | null = null;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let cajeroId: string;
  let ventaServerId: number | null = null;

  test.beforeEach(async () => {
    supa = await createDuenoClient();

    const { data: locales, error: locErr } = await supa
      .from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: canales } = await supa
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales?.length) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0].id as number;

    const { data: items } = await supa
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items?.length) throw new Error('Sin items en el tenant');
    itemId = items[0].id as number;

    const { data: emp } = await supa
      .from('rrhh_empleados').select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
    if (!emp?.length) throw new Error('Sin empleado POS activo en Local Prueba 2');
    cajeroId = emp[0].id as string;

    db = await crearOfflineDB(`o2-mutante-${crypto.randomUUID().slice(0, 8)}`, getRxStorageMemory());
    ventaServerId = null;
  });

  test.afterEach(async () => {
    if (ventaServerId) {
      try {
        await supa.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaServerId);
        await supa.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaServerId);
        await supa.from('movimientos_caja').delete().eq('venta_id', ventaServerId);
        await supa.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaServerId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    await db?.remove();
    db = null;
    try { await supa.auth.signOut(); } catch { /* idempotente */ }
  });

  test('flujo local + flushPending materializa via RPCs, reconcilia id, idempotente', async () => {
    const ctx = { tenant_id: tenantId, local_id: localId, canal_id: canalId, modo: 'mostrador', cajero_id: cajeroId };

    // ── 1. Flujo 100% local (sin red) ────────────────────────────────────────
    const ventaUuid = await abrirMesa(db!, ctx, null);
    await agregarItem(db!, ctx, ventaUuid, { item_id: itemId, precio_unitario: PRECIO, curso: 1 });
    await cobrar(db!, ctx, ventaUuid, 'efectivo', PRECIO);

    const local = await db!.ventas.findOne(ventaUuid).exec();
    expect(local?.total).toBe(PRECIO);
    expect(local?.estado).toBe('cobrada');
    expect(local?.id).toBeNull(); // aún sin sync

    // ── 2. Push vía RPCs `_offline` ──────────────────────────────────────────
    await flushPending(supa, db!);

    const sync = await db!.ventas.findOne(ventaUuid).exec();
    expect(sync?.id).not.toBeNull(); // id bigint reconciliado
    ventaServerId = sync!.id;
    const itemDoc = await db!.items.findOne({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(itemDoc?.id).not.toBeNull();
    const pagoDoc = await db!.pagos.findOne({ selector: { venta_idempotency_uuid: ventaUuid } }).exec();
    expect(pagoDoc?.id).not.toBeNull();

    // ── 3. Materializado en Supabase vía las RPCs ────────────────────────────
    const { data: ventaSrv } = await supa.from('ventas_pos')
      .select('id, estado, total, idempotency_uuid, canal_id, modo').eq('idempotency_uuid', ventaUuid).maybeSingle();
    expect(ventaSrv).not.toBeNull();
    expect(ventaSrv?.estado).toBe('cobrada');
    expect(Number(ventaSrv?.total)).toBe(PRECIO);
    expect(ventaSrv?.canal_id).toBe(canalId);
    expect(ventaSrv?.modo).toBe('mostrador');

    const { data: itemsSrv } = await supa.from('ventas_pos_items')
      .select('id, item_id, precio_unitario').eq('venta_id', ventaServerId!).is('deleted_at', null);
    expect(itemsSrv?.length).toBe(1);
    expect(itemsSrv?.[0]?.item_id).toBe(itemId);

    const { data: pagosSrv } = await supa.from('ventas_pos_pagos')
      .select('id, estado, monto').eq('venta_id', ventaServerId!).is('deleted_at', null);
    expect(pagosSrv?.length).toBe(1);
    expect(pagosSrv?.[0]?.estado).toBe('confirmado');
    expect(Number(pagosSrv?.[0]?.monto)).toBe(PRECIO);

    // ── 4. Idempotencia: re-pushear la venta (mismo uuid) no duplica ─────────
    const reId = await callAbrir(supa, sync!.toJSON() as VentaDoc);
    expect(reId).toBe(ventaServerId); // dedup por idempotency_uuid → mismo id
    const { data: dupCheck } = await supa.from('ventas_pos')
      .select('id').eq('idempotency_uuid', ventaUuid);
    expect(dupCheck?.length).toBe(1); // sin duplicados
  });
});
