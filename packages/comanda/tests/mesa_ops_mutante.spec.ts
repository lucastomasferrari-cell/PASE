import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// Endurecimiento pre-piloto (09-jun) — operaciones de mesa + reabrir venta.
//
// Cubre 3 flujos de servicio en vivo que NO tenían test:
//   1. fn_transferir_mesa_comanda — mover una venta abierta a otra mesa
//      (+ rechazo cross-local, fix IDOR F1.5).
//   2. fn_unir_mesas_comanda — fusionar dos ventas: items pasan al destino,
//      el origen queda anulado, totales recalculados (+ rechazo si cobrada).
//   3. fn_reabrir_venta_comanda — reabrir una venta COBRADA para corregirla
//      y re-cobrarla. INVARIANTE DE PLATA: el neto en movimientos_caja de la
//      venta tiene que terminar en +total UNA sola vez (el reverso del cobro
//      original debe compensar; sin eso el arqueo del turno acusa faltante
//      fantasma al cajero).
//
// DB-only contra Local Prueba 2 (patrón cobro_efectivo_mutante). Correr con
// --workers=1 (los tests de turno comparten el único turno abierto del local).

const LOCAL = 'Local Prueba 2';

test.describe('Operaciones de mesa + reabrir — mutante', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let managerId: string;
  let cajeroId: string;
  let mesaA: number;
  let mesaB: number;
  const ventasCreadas: number[] = [];

  async function abrirVenta(mesaId: number | null): Promise<number> {
    const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
      p_local_id: localId, p_modo: mesaId ? 'salon' : 'mostrador', p_canal_id: canalId,
      p_mesa_id: mesaId, p_mozo_id: null, p_cajero_id: cajeroId,
      p_covers: mesaId ? 2 : null, p_origen: 'pos', p_estado: 'abierta',
    });
    if (error) throw new Error(`abrir venta: ${error.message}`);
    const id = Number(data);
    ventasCreadas.push(id);
    return id;
  }

  async function agregarItem(ventaId: number, cantidad: number): Promise<void> {
    const { error } = await db.rpc('fn_agregar_item_comanda', {
      p_venta_id: ventaId, p_item_id: itemId, p_cantidad: cantidad, p_curso: 1,
      p_modificadores: [], p_notas: null,
    });
    if (error) throw new Error(`agregar item: ${error.message}`);
  }

  async function getVenta(ventaId: number) {
    const { data } = await db.from('ventas_pos')
      .select('id, estado, mesa_id, subtotal, total, cobrada_at')
      .eq('id', ventaId).single();
    return data as { id: number; estado: string; mesa_id: number | null; subtotal: number; total: number; cobrada_at: string | null };
  }

  async function getMesaEstado(mesaId: number): Promise<string> {
    const { data } = await db.from('mesas').select('estado').eq('id', mesaId).single();
    return (data as { estado: string }).estado;
  }

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único — seed`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: canales } = await db.from('canales')
      .select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales?.length) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0]!.id as number;

    const { data: items } = await db.from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items?.length) throw new Error('Sin items en el tenant');
    itemId = items[0]!.id as number;

    // Manager (rol_pos manager/dueno, pos_activo) — exigido por unir/transferir/reabrir.
    const { data: mgr } = await db.from('rrhh_empleados')
      .select('id').eq('local_id', localId).in('rol_pos', ['manager', 'dueno']).eq('pos_activo', true).limit(1);
    if (!mgr?.length) throw new Error('Sin manager POS activo en Local Prueba 2');
    managerId = mgr[0]!.id as string;
    cajeroId = managerId;

    // Dos mesas LIBRES del local.
    const { data: mesas } = await db.from('mesas')
      .select('id').eq('local_id', localId).eq('estado', 'libre').is('deleted_at', null)
      .order('id').limit(2);
    if (!mesas || mesas.length < 2) throw new Error('Se necesitan 2 mesas libres en Local Prueba 2');
    mesaA = mesas[0]!.id as number;
    mesaB = mesas[1]!.id as number;

    // Turno abierto (lo crea si no hay — los movimientos_caja del cobro lo exigen).
    const { data: turnoEx } = await db.from('turnos_caja')
      .select('id').eq('local_id', localId).eq('estado', 'abierto').limit(1);
    if (!turnoEx?.length) {
      const { error: tErr } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: managerId, p_monto_inicial: 0,
        p_notas: 'e2e mesa_ops', p_idempotency_key: `e2e-mesaops-turno-${Date.now()}`,
      });
      if (tErr) throw new Error(`abrir turno: ${tErr.message}`);
    }
  });

  test.afterEach(async () => {
    // OJO: supabase-js NO tira excepción — devuelve {error}. Chequear siempre,
    // si no el cleanup falla en silencio y quedan ventas zombi ocupando mesas
    // (pasó en la primera corrida de este spec).
    for (const ventaId of ventasCreadas.splice(0)) {
      // 1. Anular por la RPC real (libera mesa + compensa caja si estaba cobrada).
      const { data: v } = await db.from('ventas_pos').select('estado').eq('id', ventaId).maybeSingle();
      if (v && v.estado !== 'anulada') {
        const { error } = await db.rpc('fn_anular_venta_comanda', {
          p_venta_id: ventaId, p_manager_id: managerId, p_motivo: 'cleanup mutante mesa_ops',
          p_idempotency_key: `cleanup-mesaops-${ventaId}`,
        });
        if (error) console.error(`[cleanup] anular venta ${ventaId}:`, error.message);
      }
      // 2. Borrar rastros de caja del turno + soft-delete filas.
      const pasos: Array<[string, Promise<{ error: { message: string } | null }>]> = [
        ['movimientos_caja', db.from('movimientos_caja').delete().eq('venta_id', ventaId) as never],
        ['reversos_pendientes', db.from('reversos_pendientes').delete().eq('venta_id', ventaId) as never],
        ['items', db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId) as never],
        ['pagos', db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId) as never],
        ['venta', db.from('ventas_pos').update({ deleted_at: new Date().toISOString() }).eq('id', ventaId) as never],
      ];
      for (const [label, p] of pasos) {
        const { error } = await p;
        if (error) console.error(`[cleanup] ${label} venta ${ventaId}:`, error.message);
      }
    }
    const { error: mesasErr } = await db.from('mesas').update({ estado: 'libre' }).in('id', [mesaA, mesaB]);
    if (mesasErr) console.error('[cleanup] mesas:', mesasErr.message);
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('transferir mesa: venta se muda, mesas cambian estado, queda auditado', async () => {
    const ventaId = await abrirVenta(mesaA);
    await agregarItem(ventaId, 1);

    const { error } = await db.rpc('fn_transferir_mesa_comanda', {
      p_venta_id: ventaId, p_mesa_destino: mesaB,
      p_manager_id: managerId, p_motivo: 'mutante: cliente pidió cambiar de mesa',
    });
    expect(error).toBeNull();

    const venta = await getVenta(ventaId);
    expect(venta.mesa_id).toBe(mesaB);
    expect(venta.estado).not.toBe('anulada');
    expect(await getMesaEstado(mesaA)).toBe('libre');
    expect(await getMesaEstado(mesaB)).toBe('ocupada');

    const { data: ov } = await db.from('ventas_pos_overrides')
      .select('accion, manager_id').eq('venta_id', ventaId).eq('accion', 'transfer_table');
    expect(ov?.length).toBe(1);
    expect(ov![0]!.manager_id).toBe(managerId);
  });

  test('transferir a mesa de OTRO local → rechazado (IDOR F1.5)', async () => {
    const ventaId = await abrirVenta(mesaA);
    await agregarItem(ventaId, 1);

    const { data: mesaAjena } = await db.from('mesas')
      .select('id').neq('local_id', localId).is('deleted_at', null).limit(1);
    test.skip(!mesaAjena?.length, 'No hay mesas de otro local para probar cross-local');

    const { error } = await db.rpc('fn_transferir_mesa_comanda', {
      p_venta_id: ventaId, p_mesa_destino: mesaAjena![0]!.id,
      p_manager_id: managerId, p_motivo: 'mutante: intento cross-local',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('MESA_DESTINO_CROSS_LOCAL');

    const venta = await getVenta(ventaId);
    expect(venta.mesa_id).toBe(mesaA); // no se movió
  });

  test('unir mesas: items pasan al destino, origen anulado, totales recalculados', async () => {
    const origen = await abrirVenta(mesaA);
    await agregarItem(origen, 1);
    const destino = await abrirVenta(mesaB);
    await agregarItem(destino, 2);

    const vOrigenAntes = await getVenta(origen);
    const vDestinoAntes = await getVenta(destino);
    const subtotalEsperado = Number(vOrigenAntes.subtotal) + Number(vDestinoAntes.subtotal);

    const { error } = await db.rpc('fn_unir_mesas_comanda', {
      p_venta_origen_id: origen, p_venta_destino_id: destino,
      p_manager_id: managerId, p_motivo: 'mutante: grupos se juntaron',
    });
    expect(error).toBeNull();

    // Items del origen ahora viven en el destino.
    const { data: itemsOrigen } = await db.from('ventas_pos_items')
      .select('id').eq('venta_id', origen).neq('estado', 'anulado').is('deleted_at', null);
    expect(itemsOrigen?.length ?? 0).toBe(0);
    const { data: itemsDestino } = await db.from('ventas_pos_items')
      .select('id').eq('venta_id', destino).neq('estado', 'anulado').is('deleted_at', null);
    expect(itemsDestino?.length).toBe(2);

    // Origen anulado + su mesa libre; destino con el subtotal de ambos.
    const vOrigen = await getVenta(origen);
    expect(vOrigen.estado).toBe('anulada');
    expect(await getMesaEstado(mesaA)).toBe('libre');
    const vDestino = await getVenta(destino);
    expect(Number(vDestino.subtotal)).toBe(subtotalEsperado);

    const { data: ov } = await db.from('ventas_pos_overrides')
      .select('accion').eq('venta_id', destino).eq('accion', 'merge_mesas');
    expect(ov?.length).toBe(1);
  });

  test('unir con una venta COBRADA → rechazado', async () => {
    const origen = await abrirVenta(mesaA);
    await agregarItem(origen, 1);
    const destino = await abrirVenta(mesaB);
    await agregarItem(destino, 1);

    const vDestino = await getVenta(destino);
    const { error: cobErr } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: destino,
      p_pagos: [{ metodo: 'efectivo', monto: Number(vDestino.total), idempotency_key: `e2e-mesaops-unir-cobro-${destino}` }],
      p_propina: 0, p_cobrado_por: null,
      p_idempotency_key: `e2e-mesaops-unir-${destino}-${Date.now()}`,
    });
    expect(cobErr).toBeNull();

    const { error } = await db.rpc('fn_unir_mesas_comanda', {
      p_venta_origen_id: origen, p_venta_destino_id: destino,
      p_manager_id: managerId, p_motivo: 'mutante: no debería poder',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('NO_SE_PUEDE_UNIR_VENTA_COBRADA');
  });

  test('reabrir venta cobrada y re-cobrar NO duplica la plata del turno', async () => {
    // 1. Venta mostrador cobrada.
    const ventaId = await abrirVenta(null);
    await agregarItem(ventaId, 1);
    const venta = await getVenta(ventaId);
    const total = Number(venta.total);
    expect(total).toBeGreaterThan(0);

    const { error: cob1Err } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: 'efectivo', monto: total, idempotency_key: `e2e-mesaops-reopen-c1-${ventaId}` }],
      p_propina: 0, p_cobrado_por: null,
      p_idempotency_key: `e2e-mesaops-reopen-1-${ventaId}`,
    });
    expect(cob1Err).toBeNull();

    // 2. Reabrir (manager corrige algo).
    const { error: reErr } = await db.rpc('fn_reabrir_venta_comanda', {
      p_venta_id: ventaId, p_manager_id: managerId, p_motivo: 'mutante: corregir item',
    });
    expect(reErr).toBeNull();

    const vReabierta = await getVenta(ventaId);
    expect(vReabierta.estado).not.toBe('cobrada');
    expect(vReabierta.cobrada_at).toBeNull();

    // INVARIANTE: con la venta reabierta, el cobro original tiene que estar
    // compensado — neto movimientos_caja de la venta = 0 (cobro + reverso).
    const { data: movsTrasReabrir } = await db.from('movimientos_caja')
      .select('monto').eq('venta_id', ventaId);
    const netoTrasReabrir = (movsTrasReabrir ?? []).reduce((s, m) => s + Number(m.monto), 0);
    expect(netoTrasReabrir).toBe(0);

    // Y los pagos del cobro original no pueden seguir contando como vivos.
    const { data: pagosVivos } = await db.from('ventas_pos_pagos')
      .select('id').eq('venta_id', ventaId).eq('estado', 'confirmado').is('deleted_at', null);
    expect(pagosVivos?.length ?? 0).toBe(0);

    // 3. Re-cobrar.
    const { error: cob2Err } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: 'efectivo', monto: total, idempotency_key: `e2e-mesaops-reopen-c2-${ventaId}` }],
      p_propina: 0, p_cobrado_por: null,
      p_idempotency_key: `e2e-mesaops-reopen-2-${ventaId}`,
    });
    expect(cob2Err).toBeNull();

    // INVARIANTE FINAL: la venta vale `total` y la caja del turno tiene que
    // haber recibido `total` UNA sola vez (neto = total, no 2×total).
    const { data: movsFinal } = await db.from('movimientos_caja')
      .select('monto').eq('venta_id', ventaId);
    const netoFinal = (movsFinal ?? []).reduce((s, m) => s + Number(m.monto), 0);
    expect(netoFinal).toBe(total);

    const { data: pagosFinal } = await db.from('ventas_pos_pagos')
      .select('monto').eq('venta_id', ventaId).eq('estado', 'confirmado').is('deleted_at', null);
    expect(pagosFinal?.length).toBe(1);
    expect(Number(pagosFinal![0]!.monto)).toBe(total);
  });
});
