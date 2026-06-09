import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.6b — Test mutante fn_movimiento_caja_comanda.
//
// Invariantes:
//   1. Depósito $1000 sin manager → OK, monto positivo en movimientos_caja.
//   2. Retiro $1000 (< umbral $5000) sin manager → OK, monto positivo.
//   3. Retiro $10000 (> umbral) sin manager → RETIRO_REQUIERE_MANAGER.
//   4. Retiro $10000 con manager + motivo < 10 chars → MOTIVO_REQUERIDO.
//   5. Retiro $10000 con manager + motivo válido → OK + override registrado.
//   6. Idempotency: 2do call con misma key → mismo id, no duplica.
//   7. Tipo inválido (ej. 'apertura' manual) → TIPO_INVALIDO.

const LOCAL = 'Local Prueba 2';

test.describe('F1.6b — fn_movimiento_caja_comanda mutante', () => {
  let db: SupabaseClient;
  let localId: number;
  let empleadoId: string;
  let managerId: string;
  let turnoId: number;
  const movsCreados: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales } = await db.from('locales').select('id').eq('nombre', LOCAL);
    localId = locales![0]!.id as number;

    const { data: emp } = await db
      .from('rrhh_empleados').select('id, rol_pos').eq('local_id', localId)
      .eq('activo', true).eq('pos_activo', true).limit(2);
    if (!emp || emp.length === 0) throw new Error('Sin empleados POS en Local Prueba 2');
    empleadoId = emp[0]!.id as string;
    const manager = emp.find((e) => e.rol_pos === 'dueno' || e.rol_pos === 'manager');
    managerId = (manager?.id as string) ?? empleadoId;

    // Asegurar turno abierto
    const { data: turnoEx } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoEx && turnoEx.length > 0) {
      turnoId = turnoEx[0]!.id as number;
    } else {
      const { data: t } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: empleadoId, p_monto_inicial: 100000,
        p_notas: 'e2e mov caja', p_idempotency_key: `e2e-mov-abrir-${Date.now()}`,
      });
      turnoId = Number(t);
    }
  });

  test.afterEach(async () => {
    for (const id of movsCreados) {
      try { await db.from('movimientos_caja').delete().eq('id', id); }
      catch (e) { console.error('[cleanup mov]', e); }
    }
    // Limpiar overrides 'retiro_caja' del turno
    try {
      await db.from('ventas_pos_overrides').delete()
        .eq('local_id', localId).eq('accion', 'retiro_caja')
        .gte('created_at', new Date(Date.now() - 60_000).toISOString());
    } catch (e) { console.error('[cleanup overrides]', e); }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  // Bug arreglado 09-jun (migración 202606091500): el override del retiro grande
  // insertaba ventas_pos_overrides con venta_id=NULL/accion='retiro_caja' que
  // violaba NOT NULL + el CHECK de accion → el retiro grande con manager fallaba.
  // Fix: venta_id nullable + 'retiro_caja' en el CHECK.
  test('depósito + retiro chico OK + retiro grande requiere manager', async () => {
    // 1. Depósito $1000 sin manager → OK
    const { data: dep, error: errDep } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'deposito',
      p_monto: 1000,
      p_metodo: 'efectivo',
      p_motivo: 'refuerzo',
      p_idempotency_key: `e2e-mov-dep-${Date.now()}`,
      p_manager_id: null,
    });
    expect(errDep).toBeNull();
    expect(dep).not.toBeNull();
    movsCreados.push(Number(dep));

    const { data: movDep } = await db.from('movimientos_caja')
      .select('tipo, monto').eq('id', Number(dep)).maybeSingle();
    expect(movDep?.tipo).toBe('deposito');
    expect(Number(movDep?.monto)).toBe(1000);

    // 2. Retiro $1000 (< umbral) sin manager → OK
    const { data: ret, error: errRet } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'retiro',
      p_monto: 1000,
      p_metodo: 'efectivo',
      p_motivo: 'pago a',
      p_idempotency_key: `e2e-mov-ret-${Date.now()}`,
      p_manager_id: null,
    });
    expect(errRet).toBeNull();
    movsCreados.push(Number(ret));

    // 3. Retiro $10000 (> umbral) sin manager → debe fallar
    const { error: errSinMgr } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'retiro',
      p_monto: 10000,
      p_metodo: 'efectivo',
      p_motivo: 'pago grande sin manager',
      p_idempotency_key: `e2e-mov-grandeNoMgr-${Date.now()}`,
      p_manager_id: null,
    });
    expect(errSinMgr).not.toBeNull();
    expect(errSinMgr?.message || '').toMatch(/RETIRO_REQUIERE_MANAGER/i);

    // 4. Retiro $10000 con manager + motivo corto → MOTIVO_REQUERIDO
    const { error: errMotivoCorto } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'retiro',
      p_monto: 10000,
      p_metodo: 'efectivo',
      p_motivo: 'corto',  // < 10 chars
      p_idempotency_key: `e2e-mov-motivoCorto-${Date.now()}`,
      p_manager_id: managerId,
    });
    expect(errMotivoCorto).not.toBeNull();
    expect(errMotivoCorto?.message || '').toMatch(/MOTIVO_REQUERIDO/i);

    // 5. Retiro $10000 con manager + motivo válido → OK + override
    const idemKeyGrande = `e2e-mov-grande-${Date.now()}`;
    const { data: retGrande, error: errRetGrande } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'retiro',
      p_monto: 10000,
      p_metodo: 'efectivo',
      p_motivo: 'pago a proveedor urgente confirmado',
      p_idempotency_key: idemKeyGrande,
      p_manager_id: managerId,
    });
    expect(errRetGrande).toBeNull();
    movsCreados.push(Number(retGrande));

    // Override de retiro_caja registrado
    const { data: overrides } = await db.from('ventas_pos_overrides')
      .select('accion, monto_afectado, manager_id')
      .eq('local_id', localId).eq('accion', 'retiro_caja')
      .gte('created_at', new Date(Date.now() - 30_000).toISOString());
    expect(overrides?.length).toBeGreaterThanOrEqual(1);
    const overrideMatch = overrides?.find((o) => Number(o.monto_afectado) === 10000);
    expect(overrideMatch).toBeDefined();
    expect(overrideMatch?.manager_id).toBe(managerId);

    // 6. Idempotency: 2do call misma key → mismo id, no duplica
    const { data: retDup } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'retiro',
      p_monto: 10000,
      p_metodo: 'efectivo',
      p_motivo: 'pago a proveedor urgente confirmado',
      p_idempotency_key: idemKeyGrande,
      p_manager_id: managerId,
    });
    expect(Number(retDup)).toBe(Number(retGrande));

    // 7. Tipo inválido
    const { error: errTipo } = await db.rpc('fn_movimiento_caja_comanda', {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_tipo: 'apertura',  // no permitido manual
      p_monto: 100,
      p_metodo: 'efectivo',
      p_motivo: 'test tipo inválido',
      p_idempotency_key: `e2e-mov-tipoInval-${Date.now()}`,
      p_manager_id: null,
    });
    expect(errTipo).not.toBeNull();
    expect(errTipo?.message || '').toMatch(/TIPO_INVALIDO/i);
  });
});
