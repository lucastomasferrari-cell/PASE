import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// Order-by-seat (incremento 3) — test mutante "dividir por comensal".
// DB-only contra Supabase real con sesión dueño (patrón cobro_efectivo_mutante).
//
// Invariantes validadas:
//   1. fn_asignar_comensal_item setea ventas_pos_items.comensal (1..50).
//   2. p_comensal = 0 vuelve el ítem a "compartido" (comensal = NULL).
//   3. Cobro por comensal con pagos PARCIALES (fn_agregar_pago_venta_comanda):
//      - Primer pago parcial NO cierra la venta (queda abierta).
//      - Cuando la suma de los pagos cubre el total → venta.estado = 'cobrada'.
//      - Σ pagos confirmados = total. No hay sobre-cobro.

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO = 99_910_000 + Math.floor(Math.random() * 1000);

test.describe('Dividir por comensal — mutante', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let turnoId: number | null = null;
  let ventaId: number | null = null;
  let itemA: number | null = null;
  let itemB: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0].id as number;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en Neko');
    itemId = items[0].id as number;

    const { data: turnoExistente } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoExistente && turnoExistente.length > 0) {
      turnoId = turnoExistente[0].id as number;
    } else {
      const { data: emp } = await db
        .from('rrhh_empleados').select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
      if (!emp || emp.length === 0) throw new Error('Sin empleado POS activo en Local Prueba 2');
      const { data: turnoData, error: turnoErr } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: emp[0].id, p_monto_inicial: 0, p_notas: 'e2e comensal',
        p_idempotency_key: `e2e-abrir-turno-comensal-${Date.now()}`,
      });
      if (turnoErr) throw new Error(`Error abriendo turno: ${turnoErr.message}`);
      turnoId = Number(turnoData);
    }

    // Venta sentinel con 2 ítems (1000 + 500 = 1500).
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId, numero_local: SENTINEL_NUMERO,
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 1500, total: 1500,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    ventaId = ventaIns?.id as number;

    const { data: itA, error: iErrA } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    }).select('id').single();
    if (iErrA) throw new Error(`Error creando item A: ${iErrA.message}`);
    itemA = itA?.id as number;

    const { data: itB, error: iErrB } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 500, subtotal: 500,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    }).select('id').single();
    if (iErrB) throw new Error(`Error creando item B: ${iErrB.message}`);
    itemB = itB?.id as number;
  });

  test.afterEach(async () => {
    if (ventaId) {
      try {
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('asigna comensal + 0→NULL + cobro parcial por comensal cierra la venta', async () => {
    // ── 1. Asignar comensal 1 al ítem A, comensal 2 al ítem B ─────────────
    const { error: e1 } = await db.rpc('fn_asignar_comensal_item', { p_item_id: itemA!, p_comensal: 1 });
    expect(e1).toBeNull();
    const { error: e2 } = await db.rpc('fn_asignar_comensal_item', { p_item_id: itemB!, p_comensal: 2 });
    expect(e2).toBeNull();

    const { data: itemsAsig } = await db.from('ventas_pos_items')
      .select('id, comensal').eq('venta_id', ventaId!).is('deleted_at', null).order('id');
    const mapa = new Map(itemsAsig?.map((i) => [i.id, i.comensal]));
    expect(mapa.get(itemA!)).toBe(1);
    expect(mapa.get(itemB!)).toBe(2);

    // ── 2. p_comensal = 0 vuelve el ítem A a compartido (NULL) y reasigno ──
    const { error: e0 } = await db.rpc('fn_asignar_comensal_item', { p_item_id: itemA!, p_comensal: 0 });
    expect(e0).toBeNull();
    const { data: itemAreset } = await db.from('ventas_pos_items')
      .select('comensal').eq('id', itemA!).single();
    expect(itemAreset?.comensal).toBeNull();
    // Reasigno para seguir el flujo de cobro.
    await db.rpc('fn_asignar_comensal_item', { p_item_id: itemA!, p_comensal: 1 });

    // ── 3. Cobro parcial comensal 1 (1000) → venta sigue ABIERTA ──────────
    const { error: errP1 } = await db.rpc('fn_agregar_pago_venta_comanda', {
      p_venta_id: ventaId!, p_metodo: 'efectivo', p_monto: 1000,
      p_idempotency_key: `e2e-comensal1-${ventaId}-${Date.now()}`,
      p_cobrado_por: null, p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
    });
    expect(errP1).toBeNull();

    const { data: ventaParcial } = await db.from('ventas_pos')
      .select('estado').eq('id', ventaId!).single();
    expect(ventaParcial?.estado).toBe('abierta');

    // ── 4. Cobro parcial comensal 2 (500) → cubre total → venta COBRADA ───
    const { error: errP2 } = await db.rpc('fn_agregar_pago_venta_comanda', {
      p_venta_id: ventaId!, p_metodo: 'efectivo', p_monto: 500,
      p_idempotency_key: `e2e-comensal2-${ventaId}-${Date.now()}`,
      p_cobrado_por: null, p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
    });
    expect(errP2).toBeNull();

    const { data: ventaFinal } = await db.from('ventas_pos')
      .select('estado, cobrada_at, total').eq('id', ventaId!).single();
    expect(ventaFinal?.estado).toBe('cobrada');
    expect(ventaFinal?.cobrada_at).not.toBeNull();

    // ── 5. Σ pagos confirmados = total (sin sobre-cobro) ──────────────────
    const { data: pagos } = await db.from('ventas_pos_pagos')
      .select('monto, estado').eq('venta_id', ventaId!).is('deleted_at', null);
    expect(pagos?.length).toBe(2);
    const suma = (pagos ?? []).reduce((s, p) => s + Number(p.monto), 0);
    expect(suma).toBe(1500);
    expect((pagos ?? []).every((p) => p.estado === 'confirmado')).toBe(true);
  });
});
