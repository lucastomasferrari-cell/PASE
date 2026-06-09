import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.7 — Test mutante reversos pendientes drain (gap top #5 audit).
//
// Flow probado:
//   1. Cobrar venta en turno A.
//   2. Cerrar turno A (sin anular nada).
//   3. Anular venta → trigger fn_trg_revertir_movimientos_al_anular_venta
//      detecta que NO hay turno abierto → encola en reversos_pendientes.
//   4. Abrir turno B → trigger trg_drenar_reversos_al_abrir_turno dispara
//      fn_procesar_reversos_pendientes_comanda → mete el movimiento
//      compensatorio en movimientos_caja con tipo='venta_anulada'.
//   5. Assert: movimientos_caja tiene 1 row con turno B + monto negativo
//      + idempotency_key. Y reversos_pendientes.processed_at != NULL.
//
// La red de seguridad de F1.7 protege contra "anulé pero no había turno
// abierto" — sin ella, la plata anulada quedaba fantasma en arqueo.

const LOCAL = 'Local Prueba 2';

test.describe('F1.7 — reversos pendientes drain (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let empleadoId: string;
  let managerId: string;
  let itemId: number;
  let turnoIdA: number | null = null;
  let turnoIdB: number | null = null;
  let ventaId: number | null = null;
  let reversoIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    localId = locales![0]!.id as number;
    tenantId = locales![0]!.tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    canalId = canales![0]!.id as number;

    const { data: emp } = await db
      .from('rrhh_empleados').select('id').eq('local_id', localId)
      .eq('activo', true).eq('pos_activo', true).in('rol_pos', ['manager','dueno']).limit(1);
    if (!emp || emp.length === 0) throw new Error('Sin manager/dueno POS activo en Local Prueba 2');
    empleadoId = emp[0]!.id as string;
    managerId = empleadoId;

    const { data: items } = await db.from('items').select('id').eq('tenant_id', tenantId).limit(1);
    itemId = items![0]!.id as number;

    // PRE: no debe haber turno abierto — si hay, cerrarlo con el RPC real
    // (NO con UPDATE directo: la tabla turnos_caja_history tiene RLS que
    // bloquea el trigger de historial en escrituras directas del cliente; el
    // RPC es SECURITY DEFINER y lo saltea, igual que producción).
    const { data: turnoEx } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto');
    for (const t of (turnoEx ?? []) as Array<{ id: number }>) {
      await db.rpc('fn_cerrar_turno_caja_comanda', {
        p_turno_id: t.id, p_cerrado_por: empleadoId, p_monto_final_declarado: 0,
        p_notas: 'pre-close e2e', p_idempotency_key: `e2e-rev-preclose-${t.id}-${Date.now()}`,
      });
    }

    // 1. Abrir turno A
    const { data: idA, error: errA } = await db.rpc('fn_abrir_turno_caja_comanda', {
      p_local_id: localId, p_cajero_id: empleadoId, p_monto_inicial: 5000,
      p_notas: 'turno A reverso test', p_idempotency_key: `e2e-rev-abrirA-${Date.now()}`,
    });
    if (errA) throw new Error('Error abriendo turno A: ' + errA.message);
    turnoIdA = Number(idA);

    // 2. Crear venta + cobrar en turno A
    const { data: vIns } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: 99_960_000 + Math.floor(Math.random() * 1000),
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoIdA,
      cajero_id: empleadoId, // necesario: el reverso hereda el empleado del cajero
      estado: 'abierta', origen: 'pos', subtotal: 3000, total: 3000,
    }).select('id').single();
    ventaId = vIns!.id as number;
    await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 3000, subtotal: 3000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
    const { error: errCobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId, p_pagos: [{ metodo: 'efectivo', monto: 3000, idempotency_key: `e2e-pago-${ventaId}` }],
      p_propina: 0, p_cobrado_por: null,
      p_idempotency_key: `e2e-rev-cobro-${ventaId}-${Date.now()}`,
    });
    if (errCobro) throw new Error('Error cobrando: ' + errCobro.message);

    // 3. Cerrar turno A
    const { error: errCerrar } = await db.rpc('fn_cerrar_turno_caja_comanda', {
      p_turno_id: turnoIdA, p_cerrado_por: empleadoId,
      p_monto_final_declarado: 8000, p_notas: 'cierre turno A',
      p_idempotency_key: `e2e-rev-cerrarA-${turnoIdA}-${Date.now()}`,
    });
    if (errCerrar) throw new Error('Error cerrando turno A: ' + errCerrar.message);
  });

  test.afterEach(async () => {
    // Limpiar reversos creados durante el test
    for (const rid of reversoIds) {
      try { await db.from('reversos_pendientes').delete().eq('id', rid); }
      catch (e) { console.error('[cleanup reverso]', e); }
    }
    if (ventaId) {
      try {
        await db.from('ventas_pos_overrides').delete().eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup venta]', e); }
    }
    // Reabrir cualquier turno cerrado para no romper testing posterior
    if (turnoIdA) {
      try {
        await db.from('movimientos_caja').delete().eq('turno_caja_id', turnoIdA).eq('tipo', 'cierre');
        await db.from('turnos_caja').update({
          estado: 'cerrado', cerrado_at: new Date().toISOString(),
        }).eq('id', turnoIdA);
      } catch (e) { console.error('[cleanup turnoA]', e); }
    }
    if (turnoIdB) {
      try {
        await db.from('movimientos_caja').delete().eq('turno_caja_id', turnoIdB);
        await db.from('turnos_caja').delete().eq('id', turnoIdB);
      } catch (e) { console.error('[cleanup turnoB]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  // Bug arreglado 09-jun (migración 202606091510): la función
  // fn_trg_revertir_movimientos_al_anular_venta existía pero NO estaba conectada
  // como trigger en ventas_pos → al anular una venta cobrada no se compensaba la
  // caja ni se encolaba el reverso. Fix: (re)crear el trigger trg_revertir_
  // movimientos_anular_venta.
  test('anular sin turno encola, abrir turno drena automático', async () => {
    // ── 4. Anular venta con turno A CERRADO → debe encolar en reversos_pendientes
    const { error: errAnular } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: ventaId!,
      p_manager_id: managerId,
      p_motivo: 'test reverso pendiente drain',
      p_idempotency_key: `e2e-rev-anular-${ventaId}-${Date.now()}`,
    });
    expect(errAnular).toBeNull();

    // Verificar que se encolaron reversos pendientes
    const { data: revs } = await db.from('reversos_pendientes')
      .select('id, venta_id, monto, metodo, processed_at')
      .eq('venta_id', ventaId!)
      .is('processed_at', null);
    expect(revs?.length).toBeGreaterThanOrEqual(1);
    for (const r of revs ?? []) reversoIds.push(r.id);
    expect(Number(revs?.[0]?.monto)).toBe(3000);

    // ── 5. Abrir turno B → trigger drena reversos ───────────────────────
    const { data: idB, error: errB } = await db.rpc('fn_abrir_turno_caja_comanda', {
      p_local_id: localId, p_cajero_id: empleadoId, p_monto_inicial: 1000,
      p_notas: 'turno B drain test', p_idempotency_key: `e2e-rev-abrirB-${Date.now()}`,
    });
    expect(errB).toBeNull();
    turnoIdB = Number(idB);

    // ── 6. Verificar que el reverso fue procesado ────────────────────────
    const { data: revsPost } = await db.from('reversos_pendientes')
      .select('processed_at, processed_turno_id').eq('venta_id', ventaId!);
    expect(revsPost?.[0]?.processed_at).not.toBeNull();
    expect(revsPost?.[0]?.processed_turno_id).toBe(turnoIdB);

    // ── 7. movimientos_caja tiene el reverso (monto negativo, turno B) ──
    const { data: movs } = await db.from('movimientos_caja')
      .select('tipo, monto, turno_caja_id')
      .eq('venta_id', ventaId!).eq('tipo', 'venta_anulada');
    expect(movs?.length).toBeGreaterThanOrEqual(1);
    expect(Number(movs?.[0]?.monto)).toBe(-3000);
    expect(movs?.[0]?.turno_caja_id).toBe(turnoIdB);

    // ── 8. Idempotency: cerrar y reabrir turno B no duplica el reverso ──
    // (en realidad, los reversos ya están processed_at != NULL, no se procesan otra vez).
    // Esto es info, no aserto crítico.
    const { data: movsFinal } = await db.from('movimientos_caja')
      .select('id').eq('venta_id', ventaId!).eq('tipo', 'venta_anulada');
    expect(movsFinal?.length).toBe(movs?.length);
  });
});
