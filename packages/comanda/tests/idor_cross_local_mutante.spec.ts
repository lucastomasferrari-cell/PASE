import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.5 — Test mutante IDOR cross-local (gap top #2 audit 2026-05-15).
//
// Verifica que las RPCs sprint 2 y sprint 7 con fn_assert_empleado_en_local
// + fn_assert_local_autorizado bloquean operaciones cross-local intra-tenant.
//
// Setup: usa los 2 locales del tenant Neko ya existentes:
//   - Local 2 = Neko Belgrano (manager: Camilo Argañaraz dueno_pos)
//   - Local 7 = Local Prueba 2 (manager: Lucas Owner dueno_pos)
//
// Tests:
//   1. fn_anular_venta_comanda con manager de local A sobre venta de local B
//      → debe fallar con EMPLEADO_NO_EN_LOCAL.
//   2. fn_refund_venta_comanda idem.
//   3. fn_aplicar_descuento_comanda idem.
//
// Como dueño/superadmin la sesión bypassa local (auth_es_dueno_o_admin → true
// en fn_assert_local_autorizado). El IDOR check real está en
// fn_assert_empleado_en_local que valida que el manager pertenezca al local
// de la venta. Si el cajero (manager de Lucas) pertenece al local B, no puede
// firmar en local A.

const LOCAL_A = 'Local Prueba 2';

test.describe('F1.5 — IDOR cross-local (mutante)', () => {
  let db: SupabaseClient;
  let localAId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  // Manager de OTRO local (Belgrano = local 2)
  let managerOtroLocalId: string;
  let turnoId: number;
  let ventaId: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL_A);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL_A}"`);
    localAId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    canalId = canales![0]!.id as number;

    // Manager de OTRO local (NO local A). Buscamos rol_pos=dueno/manager con local_id != localAId.
    const { data: emp } = await db
      .from('rrhh_empleados').select('id, local_id')
      .neq('local_id', localAId)
      .in('rol_pos', ['manager', 'dueno'])
      .eq('activo', true)
      .eq('pos_activo', true)
      .limit(1);
    if (!emp || emp.length === 0) {
      throw new Error('Pre-check fail: necesito un manager activo en local distinto a Local Prueba 2');
    }
    managerOtroLocalId = emp[0]!.id as string;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    itemId = items![0]!.id as number;

    // Buscar / abrir turno en local A
    const { data: turnoEx } = await db
      .from('turnos_caja').select('id').eq('local_id', localAId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoEx && turnoEx.length > 0) {
      turnoId = turnoEx[0]!.id as number;
    } else {
      // Necesitamos un cajero del LOCAL A para abrirlo
      const { data: empA } = await db
        .from('rrhh_empleados').select('id').eq('local_id', localAId)
        .eq('activo', true).eq('pos_activo', true).limit(1);
      if (!empA || empA.length === 0) throw new Error('Sin empleado POS en Local Prueba 2');
      const { data: t } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localAId, p_cajero_id: empA[0]!.id, p_monto_inicial: 0,
        p_notas: 'e2e idor', p_idempotency_key: `e2e-idor-abrir-${Date.now()}`,
      });
      turnoId = Number(t);
    }

    // Crear venta abierta en Local A
    const { data: vIns } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localAId,
      numero_local: 99_950_000 + Math.floor(Math.random() * 1000),
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 5000, total: 5000,
    }).select('id').single();
    ventaId = vIns!.id as number;
    await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localAId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 5000, subtotal: 5000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
  });

  test.afterEach(async () => {
    if (ventaId) {
      try {
        await db.from('ventas_pos_overrides').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('manager de otro local NO puede anular/refund/descontar venta', async () => {
    // ── 1. fn_anular_venta_comanda cross-local → EMPLEADO_NO_EN_LOCAL ────
    const { error: errAnular } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: ventaId!,
      p_manager_id: managerOtroLocalId,  // manager de OTRO local
      p_motivo: 'test cross-local anular',
      p_idempotency_key: `e2e-idor-anular-${ventaId}-${Date.now()}`,
    });
    expect(errAnular).not.toBeNull();
    expect(errAnular?.message || '').toMatch(/EMPLEADO_NO_EN_LOCAL|LOCAL_NO_AUTORIZADO/i);

    // ── 2. fn_aplicar_descuento_comanda cross-local → idem ───────────────
    const { error: errDesc } = await db.rpc('fn_aplicar_descuento_comanda', {
      p_venta_id: ventaId!,
      p_monto: 500,
      p_motivo: 'test cross-local descuento',
      p_manager_id: managerOtroLocalId,
      p_idempotency_key: `e2e-idor-desc-${ventaId}-${Date.now()}`,
    });
    expect(errDesc).not.toBeNull();
    expect(errDesc?.message || '').toMatch(/EMPLEADO_NO_EN_LOCAL|LOCAL_NO_AUTORIZADO/i);

    // ── 3. Para refund necesitamos venta cobrada — cobramos primero
    //     (con cobrar normal, no usa manager_id IDOR). Después intentamos
    //     refund con manager del otro local.
    const { error: errCobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 5000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: `e2e-idor-cobro-${ventaId}-${Date.now()}`,
    });
    expect(errCobro).toBeNull();

    const { error: errRefund } = await db.rpc('fn_refund_venta_comanda', {
      p_venta_id: ventaId!,
      p_manager_id: managerOtroLocalId,
      p_motivo: 'test cross-local refund',
      p_idempotency_key: `e2e-idor-refund-${ventaId}-${Date.now()}`,
    });
    expect(errRefund).not.toBeNull();
    expect(errRefund?.message || '').toMatch(/EMPLEADO_NO_EN_LOCAL|LOCAL_NO_AUTORIZADO/i);
  });
});
