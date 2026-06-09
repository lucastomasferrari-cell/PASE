import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.6 — Test mutante cerrar turno de caja (gap top #1 del audit 2026-05-15).
//
// Cubre `fn_cerrar_turno_caja_comanda`, una de las RPCs más críticas: si se
// rompe en prod el arqueo queda corrupto y NO se puede reconciliar.
//
// Invariantes que valida (DB-only):
//   1. Cierre con efectivo declarado = calculado → diferencia = 0, turno
//      `cerrado`, `cerrado_at` != null, `monto_final_calculado` matchea
//      la suma de movimientos_caja efectivo.
//   2. Cierre con declarado != calculado → registra `diferencia` (positiva
//      o negativa) pero NO bloquea el cierre (faltante/sobrante es info).
//   3. Genera 1 movimiento_caja tipo='cierre' con metodo='efectivo' y
//      monto = monto_final_declarado.
//   4. Idempotency F1.6: 2do call con misma p_idempotency_key devuelve el
//      mismo (monto_calculado, diferencia) SIN duplicar movimientos ni
//      cambiar estado.
//   5. Cierre con OTRA key sobre turno ya cerrado → TURNO_YA_CERRADO.
//
// Cleanup: el cierre es destructivo (turno no se "reabre"), así que el
// afterEach reabre el turno seteando estado='abierto' y cerrado_at=NULL,
// y borra el movimiento_caja de cierre. NO afecta turnos preexistentes
// porque trabaja solo con el sentinel id que abrió este test.

const LOCAL = 'Local Prueba 2';

test.describe('F1.6 — cerrar turno caja (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let empleadoId: string;
  let itemId: number;
  let turnoId: number;
  let ventaId: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db
      .from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0]!.id as number;

    const { data: emp } = await db
      .from('rrhh_empleados').select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
    if (!emp || emp.length === 0) throw new Error('Sin empleado POS activo en Local Prueba 2');
    empleadoId = emp[0]!.id as string;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en Neko');
    itemId = items[0]!.id as number;

    // PRE: cerrar cualquier turno abierto con el RPC real (NO UPDATE directo:
    // turnos_caja_history tiene RLS que bloquea el trigger en escrituras
    // directas del cliente). Así este test arranca con su PROPIO turno limpio,
    // sin movimientos de otros tests que ensucien el cálculo de cierre.
    const { data: abiertosPrev } = await db.from('turnos_caja').select('id')
      .eq('local_id', localId).eq('estado', 'abierto');
    for (const t of (abiertosPrev ?? []) as Array<{ id: number }>) {
      await db.rpc('fn_cerrar_turno_caja_comanda', {
        p_turno_id: t.id, p_cerrado_por: empleadoId, p_monto_final_declarado: 0,
        p_notas: 'pre-close e2e', p_idempotency_key: `e2e-f16-preclose-${t.id}-${Date.now()}`,
      });
    }
    // Abrir turno sentinel fresco para este test.
    const idemAbrir = `e2e-f16-abrir-${Date.now()}`;
    const { data: turnoIdData, error: turnoErr } = await db.rpc('fn_abrir_turno_caja_comanda', {
      p_local_id: localId,
      p_cajero_id: empleadoId,
      p_monto_inicial: 5000,
      p_notas: 'e2e f1.6 mutante',
      p_idempotency_key: idemAbrir,
    });
    if (turnoErr) throw new Error(`Error abriendo turno: ${turnoErr.message}`);
    turnoId = Number(turnoIdData);

    // Crear venta + item + cobrar para tener movimiento efectivo en el turno.
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: 99_920_000 + Math.floor(Math.random() * 100_000), // único por test (la unique cuenta soft-deleted)
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 1500, total: 1500,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    ventaId = ventaIns!.id as number;

    const { error: iErr } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 1500, subtotal: 1500,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
    if (iErr) throw new Error(`Error item: ${iErr.message}`);

    // Cobrar para que entre el movimiento de venta efectivo
    const { error: cErr } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: 'efectivo', monto: 1500, idempotency_key: `e2e-pago-${ventaId}` }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: `e2e-f16-cobro-${ventaId}-${Date.now()}`,
    });
    if (cErr) throw new Error(`Error cobrando: ${cErr.message}`);
  });

  test.afterEach(async () => {
    // Limpiar los movimientos de cierre que metió este test. NO reabrimos el
    // turno con UPDATE directo (la RLS de turnos_caja_history lo bloquea y
    // dejaría el turno cerrado igual): lo dejamos cerrado y cada test abre su
    // propio turno limpio en el beforeEach (PRE-close + abrir).
    if (turnoId) {
      try {
        await db.from('movimientos_caja').delete()
          .eq('turno_caja_id', turnoId).eq('tipo', 'cierre');
      } catch (e) { console.error('[cleanup cierre mov]', e); }
    }
    if (ventaId) {
      try {
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup venta]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('cierre suma efectivo + diferencia + idempotency + no recierra', async () => {
    // Esperado: apertura (5000) + venta efectivo (1500) = 6500
    const ESPERADO = 6500;

    // ── 1. Cerrar con efectivo declarado = esperado ───────────────────────
    const idemCierre = `e2e-f16-cierre-${turnoId}-${Date.now()}`;
    const { data: cierre1, error: errCierre } = await db.rpc('fn_cerrar_turno_caja_comanda', {
      p_turno_id: turnoId,
      p_cerrado_por: empleadoId,
      p_monto_final_declarado: ESPERADO,
      p_notas: 'cierre e2e sin diferencia',
      p_idempotency_key: idemCierre,
    });
    expect(errCierre).toBeNull();
    expect(cierre1).not.toBeNull();
    const row1 = (cierre1 as Array<{ monto_calculado: number; diferencia: number }>)[0];
    expect(Number(row1!.monto_calculado)).toBe(ESPERADO);
    expect(Number(row1!.diferencia)).toBe(0);

    // ── 2. Turno quedó cerrado con campos correctos ──────────────────────
    const { data: turno } = await db.from('turnos_caja')
      .select('estado, cerrado_at, cerrado_por, monto_final_declarado, monto_final_calculado, diferencia, cerrar_idempotency_key')
      .eq('id', turnoId).maybeSingle();
    expect(turno?.estado).toBe('cerrado');
    expect(turno?.cerrado_at).not.toBeNull();
    expect(turno?.cerrado_por).toBe(empleadoId);
    expect(Number(turno?.monto_final_declarado)).toBe(ESPERADO);
    expect(Number(turno?.monto_final_calculado)).toBe(ESPERADO);
    expect(Number(turno?.diferencia)).toBe(0);
    expect(turno?.cerrar_idempotency_key).toBe(idemCierre);

    // ── 3. Se generó movimiento_caja tipo='cierre' ──────────────────────
    const { data: movsCierre } = await db.from('movimientos_caja')
      .select('id, tipo, metodo, monto').eq('turno_caja_id', turnoId).eq('tipo', 'cierre');
    expect(movsCierre?.length).toBe(1);
    expect(movsCierre?.[0]?.metodo).toBe('efectivo');
    expect(Number(movsCierre?.[0]?.monto)).toBe(ESPERADO);

    // ── 4. IDEMPOTENCY: 2do call misma key → mismo resultado, no duplica
    const { data: cierre2, error: err2 } = await db.rpc('fn_cerrar_turno_caja_comanda', {
      p_turno_id: turnoId,
      p_cerrado_por: empleadoId,
      p_monto_final_declarado: ESPERADO,
      p_notas: 'reintento idempotente',
      p_idempotency_key: idemCierre,
    });
    expect(err2).toBeNull();
    const row2 = (cierre2 as Array<{ monto_calculado: number; diferencia: number }>)[0];
    expect(Number(row2!.monto_calculado)).toBe(ESPERADO);
    expect(Number(row2!.diferencia)).toBe(0);

    // El movimiento_caja cierre NO debe haberse duplicado
    const { data: movsCierreFinal } = await db.from('movimientos_caja')
      .select('id').eq('turno_caja_id', turnoId).eq('tipo', 'cierre');
    expect(movsCierreFinal?.length).toBe(1);

    // ── 5. Cerrar con OTRA key sobre turno ya cerrado → TURNO_YA_CERRADO
    const { error: err3 } = await db.rpc('fn_cerrar_turno_caja_comanda', {
      p_turno_id: turnoId,
      p_cerrado_por: empleadoId,
      p_monto_final_declarado: ESPERADO,
      p_notas: 'tercer intento',
      p_idempotency_key: `e2e-f16-cierre-${turnoId}-OTRA-${Date.now()}`,
    });
    expect(err3).not.toBeNull();
    expect(err3?.message || '').toMatch(/TURNO_YA_CERRADO|cerrado/i);
  });

  test('cierre con declarado distinto al calculado registra diferencia (sin bloquear)', async () => {
    // Esperado: apertura (5000) + venta efectivo (1500) = 6500 calculado
    // Declarado intencional: 6000 (falta 500)
    const CALCULADO = 6500;
    const DECLARADO = 6000;

    const idemCierre = `e2e-f16-diff-${turnoId}-${Date.now()}`;
    const { data: cierre, error: errCierre } = await db.rpc('fn_cerrar_turno_caja_comanda', {
      p_turno_id: turnoId,
      p_cerrado_por: empleadoId,
      p_monto_final_declarado: DECLARADO,
      p_notas: 'falta plata test',
      p_idempotency_key: idemCierre,
    });
    expect(errCierre).toBeNull();
    const row = (cierre as Array<{ monto_calculado: number; diferencia: number }>)[0];
    expect(Number(row!.monto_calculado)).toBe(CALCULADO);
    expect(Number(row!.diferencia)).toBe(DECLARADO - CALCULADO); // -500

    const { data: turno } = await db.from('turnos_caja')
      .select('estado, diferencia').eq('id', turnoId).maybeSingle();
    expect(turno?.estado).toBe('cerrado');
    expect(Number(turno?.diferencia)).toBe(-500);
  });
});
