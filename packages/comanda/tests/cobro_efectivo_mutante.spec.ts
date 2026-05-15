import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.4 — Test mutante cobro efectivo (auditoría estructural 2026-05-15).
// COMANDA no tenía tests E2E mutantes (deuda C2). Este test es el primero del
// patrón. DB-only — no navega UI; pega contra Supabase real con sesión dueño.
//
// Invariantes validadas:
//   1. fn_cobrar_venta_comanda con pago efectivo cubierto:
//      → venta.estado = 'cobrada'
//      → venta.cobrada_at != null
//      → ventas_pos_pagos.estado = 'confirmado' con monto = total
//      → movimientos_caja generado con tipo='venta', monto=+total, metodo='efectivo'
//   2. Idempotency: 2do call con misma cobro_idempotency_key devuelve mismo
//      resultado sin duplicar pago ni movimiento (sprint 7 patrón).
//   3. NO acepta cobrar venta ya cobrada (re-cobro doble distinto a idempotency).

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO = 99_900_000 + Math.floor(Math.random() * 1000);

test.describe('Cobro efectivo — mutante', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let turnoId: number | null = null;
  let ventaId: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    // ── Local Prueba 2 ────────────────────────────────────────────────────
    const { data: locales, error: locErr } = await db
      .from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // ── Canal mostrador (default) ─────────────────────────────────────────
    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe en Neko');
    canalId = canales[0].id as number;

    // ── Item cualquiera para usar ─────────────────────────────────────────
    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en Neko — crear uno antes.');
    itemId = items[0].id as number;

    // ── Turno abierto (si no hay, abrimos uno) ────────────────────────────
    const { data: turnoExistente } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoExistente && turnoExistente.length > 0) {
      turnoId = turnoExistente[0].id as number;
    } else {
      // Crear uno mediante RPC. cajero_id = id del primer empleado pos_activo del local.
      const { data: emp } = await db
        .from('rrhh_empleados')
        .select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
      if (!emp || emp.length === 0) throw new Error('Sin empleado POS activo en Local Prueba 2');
      const { data: turnoData, error: turnoErr } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: emp[0].id, p_monto_inicial: 0, p_notas: 'e2e mutante',
        p_idempotency_key: `e2e-abrir-turno-${Date.now()}`,
      });
      if (turnoErr) throw new Error(`Error abriendo turno: ${turnoErr.message}`);
      turnoId = Number(turnoData);
    }

    // ── Crear venta_pos sentinel + 1 item ─────────────────────────────────
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO,
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 1000, total: 1000,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    ventaId = ventaIns?.id as number;

    const { error: iErr } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
    if (iErr) throw new Error(`Error creando item: ${iErr.message}`);
  });

  test.afterEach(async () => {
    if (ventaId) {
      try {
        // Soft-delete items + pagos + venta + reverso movimientos. NO cerramos turno.
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('cobro efectivo cubierto + idempotency + no re-cobra ya cobrada', async () => {
    // ── 1. Cobrar venta con pago efectivo ─────────────────────────────────
    const idempotencyKey = `e2e-cobro-${ventaId}-${Date.now()}`;
    const { data: cobro1, error: errCobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 1000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: idempotencyKey,
    });
    expect(errCobro).toBeNull();
    expect(Number(cobro1)).toBe(1000);

    // ── Venta cobrada ────────────────────────────────────────────────────
    const { data: venta } = await db.from('ventas_pos')
      .select('estado, cobrada_at, total, cobro_idempotency_key').eq('id', ventaId!).maybeSingle();
    expect(venta?.estado).toBe('cobrada');
    expect(venta?.cobrada_at).not.toBeNull();
    expect(venta?.cobro_idempotency_key).toBe(idempotencyKey);

    // ── Pago confirmado ──────────────────────────────────────────────────
    const { data: pagos } = await db.from('ventas_pos_pagos')
      .select('monto, metodo, estado').eq('venta_id', ventaId!).is('deleted_at', null);
    expect(pagos?.length).toBe(1);
    expect(pagos?.[0]?.estado).toBe('confirmado');
    expect(Number(pagos?.[0]?.monto)).toBe(1000);
    expect(pagos?.[0]?.metodo).toBe('efectivo');

    // ── Movimiento caja generado ─────────────────────────────────────────
    const { data: movs } = await db.from('movimientos_caja')
      .select('tipo, monto, metodo').eq('venta_id', ventaId!);
    expect(movs?.length).toBeGreaterThanOrEqual(1);
    const movVenta = movs?.find(m => m.tipo === 'venta');
    expect(movVenta).toBeDefined();
    expect(Number(movVenta?.monto)).toBe(1000);

    // ── 2. Idempotency: 2do call con misma key → mismo resultado ─────────
    const { data: cobro2, error: errCobro2 } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 1000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: idempotencyKey,
    });
    expect(errCobro2).toBeNull();
    expect(Number(cobro2)).toBe(1000);

    // Verificar que NO se duplicaron pagos ni movimientos.
    const { data: pagosPost } = await db.from('ventas_pos_pagos')
      .select('id').eq('venta_id', ventaId!).is('deleted_at', null);
    expect(pagosPost?.length).toBe(1);
    const { data: movsPost } = await db.from('movimientos_caja')
      .select('id').eq('venta_id', ventaId!);
    expect(movsPost?.length).toBe(movs?.length);

    // ── 3. 3er call con OTRA key → falla (venta ya cobrada) ──────────────
    const { error: err3 } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 1000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: `e2e-cobro-${ventaId}-otra-key-${Date.now()}`,
    });
    expect(err3).not.toBeNull();
    expect(err3?.message || '').toMatch(/VENTA_YA_COBRADA|estado/i);
  });
});
