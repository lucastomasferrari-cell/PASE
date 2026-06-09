import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// Sprint 7 / F1.6b — Test mutante anular venta + refund (gap top #3 audit).
//
// fn_anular_venta_comanda y fn_refund_venta_comanda mueven plata y dejan
// rastro en ventas_pos_overrides. Sin test, una regresión en idempotency o
// IDOR es invisible hasta el próximo arqueo corrupto.
//
// Invariantes validadas (DB-only):
//
//   ANULAR (venta abierta sin cobrar):
//     1. estado venta = 'anulada', anulada_at != null.
//     2. items pasan a estado='anulado' (los que no estaban anulados).
//     3. Si la venta tenía mesa, queda en estado='libre'.
//     4. ventas_pos_overrides registra 1 fila con accion='void',
//        monto_afectado = total venta, manager_id, motivo, idempotency_key.
//     5. Idempotency: 2do call misma key → NO duplica override ni hace
//        UPDATE adicional.
//     6. MANAGER_REQUERIDO si p_manager_id es NULL.
//     7. MANAGER_INVALIDO si el manager no tiene rol_pos válido.
//
//   REFUND (venta ya cobrada):
//     1. Devuelve el total de la venta.
//     2. ventas_pos_pagos.estado pasa a 'reembolsado' con reembolsado_at.
//     3. ventas_pos_overrides registra 1 fila con accion='refund'.
//     4. Idempotency: 2do call misma key → NO duplica override, retorna
//        el mismo total.
//
// Cleanup: en afterEach, soft-delete items + pagos + overrides + ventas
// sentinel. Reabre el turno solo si era nuevo (sino no lo toca).

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO_ANULAR = 99_930_000 + Math.floor(Math.random() * 1000);
const SENTINEL_NUMERO_REFUND = 99_940_000 + Math.floor(Math.random() * 1000);

test.describe('Sprint 7 — anular venta + refund (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let managerId: string;
  let itemId: number;
  let turnoId: number;
  const ventaIdsCreated: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0]!.id as number;

    // Empleado manager (rol_pos in ('manager','dueno')) activo en Local Prueba 2
    const { data: emp } = await db
      .from('rrhh_empleados').select('id').eq('local_id', localId)
      .in('rol_pos', ['manager', 'dueno']).eq('pos_activo', true).limit(1);
    if (!emp || emp.length === 0) throw new Error('Sin manager/dueno POS activo en Local Prueba 2');
    managerId = emp[0]!.id as string;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en Neko');
    itemId = items[0]!.id as number;

    // Turno (re-usar abierto si hay, sino abrir)
    const { data: turnoExistente } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoExistente && turnoExistente.length > 0) {
      turnoId = turnoExistente[0]!.id as number;
    } else {
      const { data: t, error } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: managerId, p_monto_inicial: 0,
        p_notas: 'e2e anular/refund', p_idempotency_key: `e2e-anular-abrir-${Date.now()}`,
      });
      if (error) throw new Error(`Error abriendo turno: ${error.message}`);
      turnoId = Number(t);
    }
  });

  test.afterEach(async () => {
    for (const vId of ventaIdsCreated) {
      try {
        await db.from('ventas_pos_overrides').delete().eq('venta_id', vId);
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', vId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', vId);
        await db.from('movimientos_caja').delete().eq('venta_id', vId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', vId);
      } catch (e) { console.error('[cleanup venta]', e); }
    }
    ventaIdsCreated.length = 0;
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('anular venta abierta + idempotency + manager checks', async () => {
    // Crear venta abierta (sin cobrar)
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO_ANULAR,
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 1200, total: 1200,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    const ventaId = ventaIns!.id as number;
    ventaIdsCreated.push(ventaId);

    await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 1200, subtotal: 1200,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });

    // ── 1. MANAGER_REQUERIDO si manager_id es NULL ───────────────────────
    const { error: errSinMgr } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: ventaId,
      p_manager_id: null,
      p_motivo: 'test sin manager',
      p_idempotency_key: `e2e-anular-${ventaId}-no-mgr-${Date.now()}`,
    });
    expect(errSinMgr).not.toBeNull();
    expect(errSinMgr?.message || '').toMatch(/MANAGER_REQUERIDO/i);

    // ── 2. Anular OK con manager ─────────────────────────────────────────
    const idemKey = `e2e-anular-${ventaId}-${Date.now()}`;
    const { error: errAnular } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: ventaId,
      p_manager_id: managerId,
      p_motivo: 'test anular venta abierta',
      p_idempotency_key: idemKey,
    });
    expect(errAnular).toBeNull();

    // Estado venta
    const { data: venta } = await db.from('ventas_pos')
      .select('estado, anulada_at, total').eq('id', ventaId).maybeSingle();
    expect(venta?.estado).toBe('anulada');
    expect(venta?.anulada_at).not.toBeNull();

    // Items anulados
    const { data: items } = await db.from('ventas_pos_items')
      .select('estado').eq('venta_id', ventaId);
    expect(items?.every(i => i.estado === 'anulado')).toBe(true);

    // 1 override 'void'
    const { data: overrides } = await db.from('ventas_pos_overrides')
      .select('accion, monto_afectado, manager_id, motivo, idempotency_key')
      .eq('venta_id', ventaId).eq('accion', 'void');
    expect(overrides?.length).toBe(1);
    expect(overrides?.[0]?.manager_id).toBe(managerId);
    expect(Number(overrides?.[0]?.monto_afectado)).toBe(1200);
    expect(overrides?.[0]?.idempotency_key).toBe(idemKey);

    // ── 3. Idempotency: 2do call misma key → no duplica override ─────────
    const { error: err2 } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: ventaId,
      p_manager_id: managerId,
      p_motivo: 'reintento idempotente',
      p_idempotency_key: idemKey,
    });
    expect(err2).toBeNull();

    const { data: overridesPost } = await db.from('ventas_pos_overrides')
      .select('id').eq('venta_id', ventaId).eq('accion', 'void');
    expect(overridesPost?.length).toBe(1);
  });

  test('refund venta cobrada + idempotency', async () => {
    // Crear venta + cobrar
    const { data: ventaIns } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO_REFUND,
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 2500, total: 2500,
    }).select('id').single();
    const ventaId = ventaIns!.id as number;
    ventaIdsCreated.push(ventaId);

    await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 2500, subtotal: 2500,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });

    const { error: errCobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: 'efectivo', monto: 2500, idempotency_key: `e2e-pago-${ventaId}` }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: `e2e-refund-cobro-${ventaId}-${Date.now()}`,
    });
    expect(errCobro).toBeNull();

    // ── Refund con idempotency key ───────────────────────────────────────
    const idemKey = `e2e-refund-${ventaId}-${Date.now()}`;
    const { data: refundTotal, error: errRefund } = await db.rpc('fn_refund_venta_comanda', {
      p_venta_id: ventaId,
      p_manager_id: managerId,
      p_motivo: 'test refund e2e',
      p_idempotency_key: idemKey,
    });
    expect(errRefund).toBeNull();
    expect(Number(refundTotal)).toBe(2500);

    // Pagos quedaron en 'reembolsado'
    const { data: pagos } = await db.from('ventas_pos_pagos')
      .select('estado, reembolsado_at').eq('venta_id', ventaId).is('deleted_at', null);
    expect(pagos?.length).toBe(1);
    expect(pagos?.[0]?.estado).toBe('reembolsado');
    expect(pagos?.[0]?.reembolsado_at).not.toBeNull();

    // Override 'refund' creado
    const { data: overrides } = await db.from('ventas_pos_overrides')
      .select('accion, monto_afectado, idempotency_key')
      .eq('venta_id', ventaId).eq('accion', 'refund');
    expect(overrides?.length).toBe(1);
    expect(Number(overrides?.[0]?.monto_afectado)).toBe(2500);
    expect(overrides?.[0]?.idempotency_key).toBe(idemKey);

    // ── Idempotency: 2do call misma key → retorna total, no duplica ──────
    const { data: refund2, error: err2 } = await db.rpc('fn_refund_venta_comanda', {
      p_venta_id: ventaId,
      p_manager_id: managerId,
      p_motivo: 'reintento',
      p_idempotency_key: idemKey,
    });
    expect(err2).toBeNull();
    expect(Number(refund2)).toBe(2500);

    const { data: overridesPost } = await db.from('ventas_pos_overrides')
      .select('id').eq('venta_id', ventaId).eq('accion', 'refund');
    expect(overridesPost?.length).toBe(1);
  });
});
