import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// ─────────────────────────────────────────────────────────────────────────
// ENSAYO GENERAL — servicio POS completo de punta a punta (Lucas 09-jun).
//
// A diferencia de los mutantes (que prueban UNA pieza), esto encadena un
// SERVICIO entero contra los RPCs reales del backend + triggers, sobre
// Local Prueba 2, y verifica INVARIANTES de consistencia (no montos mágicos):
// abrir turno → varias ventas (mostrador, anular ítem c/ manager, descuento,
// cobro full, cobro split, dividir por comensal, partir cuenta, anular venta)
// → verificar plata/estados → limpieza total.
//
// Nivel: backend (db.rpc directo) — es donde la integridad de plata importa
// para un servicio en vivo. El path offline/UI se cubre aparte.
// ─────────────────────────────────────────────────────────────────────────

const LOCAL = 'Local Prueba 2';
const SENTINEL = 99_800_000 + Math.floor(Math.random() * 100_000);

interface Ctx {
  db: SupabaseClient;
  localId: number;
  tenantId: string;
  canalId: number;
  itemIds: number[];
  cajeroId: string;
  managerId: string;
  turnoId: number;
  metodos: string[];
}

const ventasCreadas: number[] = [];
let ctx: Ctx;
let numeroSeq = 0;
let turnoAbiertoPorTest = false; // true si ESTE test abrió el turno → lo cierra al final

function nextNumero(): number { return SENTINEL + (numeroSeq++); }
function idem(label: string): string { return `e2e-servicio-${SENTINEL}-${label}`; }

// Abre una venta REAL via fn_abrir_venta_comanda (mostrador) y registra el id
// para cleanup. Devuelve el ventaId.
async function abrirVenta(db: SupabaseClient, c: Ctx): Promise<number> {
  const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
    p_local_id: c.localId, p_modo: 'mostrador', p_canal_id: c.canalId,
    p_mesa_id: null, p_mozo_id: null, p_cajero_id: c.cajeroId,
    p_covers: null, p_origen: 'pos', p_estado: 'abierta',
  });
  if (error) throw new Error(`abrir venta: ${error.message}`);
  const id = Number(data);
  ventasCreadas.push(id);
  return id;
}

async function agregarItem(db: SupabaseClient, ventaId: number, itemId: number, cantidad: number, curso = 1): Promise<number> {
  const { data, error } = await db.rpc('fn_agregar_item_comanda', {
    p_venta_id: ventaId, p_item_id: itemId, p_cantidad: cantidad, p_curso: curso,
    p_modificadores: [], p_notas: null,
  });
  if (error) throw new Error(`agregar item: ${error.message}`);
  return Number(data);
}

async function getVenta(db: SupabaseClient, ventaId: number) {
  const { data } = await db.from('ventas_pos')
    .select('id, estado, subtotal, descuento_total, total, cobrada_at, numero_local')
    .eq('id', ventaId).single();
  return data as { id: number; estado: string; subtotal: number; descuento_total: number; total: number; cobrada_at: string | null; numero_local: number };
}

test.describe('Servicio completo — ensayo general', () => {
  test.beforeAll(async () => {
    const db = await createDuenoClient();

    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    const localId = locales[0]!.id as number;
    const tenantId = locales[0]!.tenant_id as string;

    const { data: canales } = await db.from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales?.length) throw new Error('Canal "mostrador" no existe');
    const canalId = canales[0]!.id as number;

    // 2-3 items para tener montos reales.
    const { data: items } = await db.from('items').select('id').eq('tenant_id', tenantId).limit(3);
    if (!items || items.length < 2) throw new Error('Necesito ≥2 items en Neko');
    const itemIds = items.map(i => i.id as number);

    // Cajero POS activo + un manager/dueño para los overrides.
    const { data: cajeros } = await db.from('rrhh_empleados').select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
    if (!cajeros?.length) throw new Error('Sin empleado POS activo en Local Prueba 2');
    const cajeroId = cajeros[0]!.id as string;

    const { data: mgrs } = await db.from('rrhh_empleados').select('id').eq('local_id', localId).in('rol_pos', ['manager', 'dueno']).limit(1);
    if (!mgrs?.length) throw new Error('Sin empleado rol_pos manager/dueño en Local Prueba 2 — necesario para overrides');
    const managerId = mgrs[0]!.id as string;

    // Turno: reusar el abierto si hay; sino abrir uno.
    let turnoId: number;
    const { data: turnoExist } = await db.from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto').order('id', { ascending: false }).limit(1);
    if (turnoExist?.length) {
      turnoId = turnoExist[0]!.id as number;
    } else {
      const { data: t, error: te } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: cajeroId, p_monto_inicial: 0,
        p_notas: 'e2e servicio completo', p_idempotency_key: idem('turno'),
      });
      if (te) throw new Error(`abrir turno: ${te.message}`);
      turnoId = Number(t);
      turnoAbiertoPorTest = true; // lo cerramos en afterAll para no dejarlo colgado
    }

    const { data: mets } = await db.from('metodos_cobro').select('slug').eq('activo', true).or(`local_id.eq.${localId},local_id.is.null`);
    const metodos = (mets || []).map(m => m.slug as string);
    if (!metodos.includes('efectivo')) metodos.unshift('efectivo');

    ctx = { db, localId, tenantId, canalId, itemIds, cajeroId, managerId, turnoId, metodos };
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const { db } = ctx;
    const now = new Date().toISOString();
    for (const vId of ventasCreadas) {
      try { await db.from('ventas_pos_items').update({ deleted_at: now }).eq('venta_id', vId); } catch (e) { console.error('[cleanup items]', e); }
      try { await db.from('ventas_pos_pagos').update({ deleted_at: now }).eq('venta_id', vId); } catch (e) { console.error('[cleanup pagos]', e); }
      try { await db.from('movimientos_caja').delete().eq('venta_id', vId); } catch (e) { console.error('[cleanup movs]', e); }
      try { await db.from('ventas_pos').update({ deleted_at: now, estado: 'anulada' }).eq('id', vId); } catch (e) { console.error('[cleanup venta]', e); }
    }
    // Cerrar el turno SOLO si lo abrimos nosotros (con el RPC real, no UPDATE
    // directo — la RLS de turnos_caja_history bloquea las escrituras directas).
    if (turnoAbiertoPorTest) {
      try {
        await db.rpc('fn_cerrar_turno_caja_comanda', {
          p_turno_id: ctx.turnoId, p_cerrado_por: ctx.cajeroId, p_monto_final_declarado: 0,
          p_notas: 'cierre e2e servicio', p_idempotency_key: idem('cierre-turno'),
        });
      } catch (e) { console.error('[cleanup turno]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idem */ }
  });

  test('un servicio entero mantiene la plata y los estados consistentes', async () => {
    const { db } = ctx;

    // ── VENTA 1 — mostrador simple: 2 ítems → mandar curso → cobrar efectivo full ──
    const v1 = await abrirVenta(db, ctx);
    await agregarItem(db, v1, ctx.itemIds[0]!, 2, 1);
    await agregarItem(db, v1, ctx.itemIds[1]!, 1, 1);
    const { data: count1 } = await db.rpc('fn_mandar_curso_comanda', { p_venta_id: v1, p_curso: 1 });
    expect(Number(count1)).toBeGreaterThanOrEqual(1);
    let venta1 = await getVenta(db, v1);
    expect(venta1.estado).toBe('abierta');
    expect(Number(venta1.total)).toBeGreaterThan(0);
    // Invariante: total = subtotal - descuento (sin descuento, total = subtotal).
    expect(Number(venta1.total)).toBeCloseTo(Number(venta1.subtotal) - Number(venta1.descuento_total), 1);
    const { error: e1 } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: v1, p_pagos: [{ metodo: 'efectivo', monto: Number(venta1.total), idempotency_key: idem('cobro-v1-p1') }],
      p_propina: 0, p_cobrado_por: ctx.cajeroId, p_idempotency_key: idem('cobro-v1'),
    });
    expect(e1).toBeNull();
    venta1 = await getVenta(db, v1);
    expect(venta1.estado).toBe('cobrada');
    expect(venta1.cobrada_at).not.toBeNull();
    // Pagos confirmados suman el total.
    const { data: pagos1 } = await db.from('ventas_pos_pagos').select('monto, estado').eq('venta_id', v1).is('deleted_at', null);
    const sumPagos1 = (pagos1 || []).reduce((s, p) => s + Number(p.monto), 0);
    expect(sumPagos1).toBeCloseTo(Number(venta1.total), 1);
    expect((pagos1 || []).every(p => p.estado === 'confirmado')).toBe(true);
    // Movimiento de caja de venta generado.
    const { data: movs1 } = await db.from('movimientos_caja').select('tipo, monto').eq('venta_id', v1);
    expect((movs1 || []).some(m => m.tipo === 'venta')).toBe(true);

    // ── VENTA 2 — anular ítem (manager) + descuento (manager) + cobro split ──
    const v2 = await abrirVenta(db, ctx);
    const it2a = await agregarItem(db, v2, ctx.itemIds[0]!, 1, 1);
    await agregarItem(db, v2, ctx.itemIds[1]!, 2, 1);
    const venta2pre = await getVenta(db, v2);
    // Anular el primer ítem con manager.
    const { error: eAnItem } = await db.rpc('fn_anular_item_comanda', {
      p_item_id: it2a, p_manager_id: ctx.managerId, p_motivo: 'e2e: cliente se arrepintió',
      p_idempotency_key: idem('anular-item-v2'),
    });
    expect(eAnItem).toBeNull();
    const venta2post = await getVenta(db, v2);
    // El total bajó (se anuló un ítem) y sigue consistente.
    expect(Number(venta2post.total)).toBeLessThan(Number(venta2pre.total));
    expect(Number(venta2post.total)).toBeCloseTo(Number(venta2post.subtotal) - Number(venta2post.descuento_total), 1);
    // Descuento chico (manager). 10% del subtotal.
    const montoDesc = Math.round(Number(venta2post.subtotal) * 0.10);
    const { error: eDesc } = await db.rpc('fn_aplicar_descuento_comanda', {
      p_venta_id: v2, p_monto: montoDesc, p_motivo: 'e2e: descuento fidelidad',
      p_manager_id: ctx.managerId, p_idempotency_key: idem('desc-v2'),
    });
    expect(eDesc).toBeNull();
    let venta2 = await getVenta(db, v2);
    expect(Number(venta2.descuento_total)).toBeGreaterThanOrEqual(montoDesc - 1);
    expect(Number(venta2.total)).toBeCloseTo(Number(venta2.subtotal) - Number(venta2.descuento_total), 1);
    expect(Number(venta2.total)).toBeGreaterThanOrEqual(0);
    // Cobro split: mitad efectivo, mitad otro método (o todo efectivo si solo hay uno).
    const total2 = Number(venta2.total);
    const m2 = ctx.metodos.length > 1 ? ctx.metodos[1]! : 'efectivo';
    const parte = Math.floor(total2 / 2);
    const pagosSplit = parte > 0
      ? [{ metodo: 'efectivo', monto: parte, idempotency_key: idem('cobro-v2-p1') }, { metodo: m2, monto: total2 - parte, idempotency_key: idem('cobro-v2-p2') }]
      : [{ metodo: 'efectivo', monto: total2, idempotency_key: idem('cobro-v2-p1') }];
    const { error: e2 } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: v2, p_pagos: pagosSplit, p_propina: 0, p_cobrado_por: ctx.cajeroId,
      p_idempotency_key: idem('cobro-v2'),
    });
    expect(e2).toBeNull();
    venta2 = await getVenta(db, v2);
    expect(venta2.estado).toBe('cobrada');
    const { data: pagos2 } = await db.from('ventas_pos_pagos').select('monto').eq('venta_id', v2).is('deleted_at', null);
    expect((pagos2 || []).reduce((s, p) => s + Number(p.monto), 0)).toBeCloseTo(total2, 1);

    // ── VENTA 3 — dividir por comensal: 2 ítems, 2 comensales, cobro parcial x2 ──
    const v3 = await abrirVenta(db, ctx);
    const it3a = await agregarItem(db, v3, ctx.itemIds[0]!, 1, 1);
    const it3b = await agregarItem(db, v3, ctx.itemIds[1]!, 1, 1);
    await db.rpc('fn_asignar_comensal_item', { p_item_id: it3a, p_comensal: 1 });
    await db.rpc('fn_asignar_comensal_item', { p_item_id: it3b, p_comensal: 2 });
    const venta3 = await getVenta(db, v3);
    const total3 = Number(venta3.total);
    // Comensal 1 paga su ítem; comensal 2 el resto. Primer pago parcial NO cierra.
    const { data: items3 } = await db.from('ventas_pos_items').select('subtotal, comensal').eq('venta_id', v3).is('deleted_at', null);
    const sub1 = (items3 || []).filter(i => i.comensal === 1).reduce((s, i) => s + Number(i.subtotal), 0);
    const { error: ep1 } = await db.rpc('fn_agregar_pago_venta_comanda', {
      p_venta_id: v3, p_metodo: 'efectivo', p_monto: sub1,
      p_idempotency_key: idem('comensal1-v3'), p_cobrado_por: ctx.cajeroId,
      p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
    });
    expect(ep1).toBeNull();
    expect((await getVenta(db, v3)).estado).toBe('abierta'); // parcial no cierra
    const { error: ep2 } = await db.rpc('fn_agregar_pago_venta_comanda', {
      p_venta_id: v3, p_metodo: 'efectivo', p_monto: total3 - sub1,
      p_idempotency_key: idem('comensal2-v3'), p_cobrado_por: ctx.cajeroId,
      p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
    });
    expect(ep2).toBeNull();
    expect((await getVenta(db, v3)).estado).toBe('cobrada'); // ya cubierto → cierra

    // ── VENTA 4 — partir cuenta: mover 1 ítem a una venta nueva, cobrar ambas ──
    const v4 = await abrirVenta(db, ctx);
    const it4a = await agregarItem(db, v4, ctx.itemIds[0]!, 1, 1);
    await agregarItem(db, v4, ctx.itemIds[1]!, 1, 1);
    const venta4pre = await getVenta(db, v4);
    const { data: v4nuevaRaw, error: ePartir } = await db.rpc('fn_partir_cuenta_comanda', {
      p_venta_id: v4, p_item_ids: [it4a], p_manager_id: ctx.managerId, p_motivo: 'e2e: pagan separado',
    });
    expect(ePartir).toBeNull();
    const v4nueva = Number(v4nuevaRaw);
    ventasCreadas.push(v4nueva);
    const venta4 = await getVenta(db, v4);
    const venta4n = await getVenta(db, v4nueva);
    // Invariante: subtotal original = subtotal restante + subtotal de la nueva.
    expect(Number(venta4.subtotal) + Number(venta4n.subtotal)).toBeCloseTo(Number(venta4pre.subtotal), 1);
    // Cobrar las dos.
    await db.rpc('fn_cobrar_venta_comanda', { p_venta_id: v4, p_pagos: [{ metodo: 'efectivo', monto: Number(venta4.total), idempotency_key: idem('cobro-v4-p1') }], p_propina: 0, p_cobrado_por: ctx.cajeroId, p_idempotency_key: idem('cobro-v4') });
    await db.rpc('fn_cobrar_venta_comanda', { p_venta_id: v4nueva, p_pagos: [{ metodo: 'efectivo', monto: Number(venta4n.total), idempotency_key: idem('cobro-v4n-p1') }], p_propina: 0, p_cobrado_por: ctx.cajeroId, p_idempotency_key: idem('cobro-v4n') });
    expect((await getVenta(db, v4)).estado).toBe('cobrada');
    expect((await getVenta(db, v4nueva)).estado).toBe('cobrada');

    // ── VENTA 5 — anular venta entera con manager ──
    const v5 = await abrirVenta(db, ctx);
    await agregarItem(db, v5, ctx.itemIds[0]!, 1, 1);
    const { error: eAnVenta } = await db.rpc('fn_anular_venta_comanda', {
      p_venta_id: v5, p_manager_id: ctx.managerId, p_motivo: 'e2e: se canceló la orden',
      p_idempotency_key: idem('anular-v5'),
    });
    expect(eAnVenta).toBeNull();
    expect((await getVenta(db, v5)).estado).toBe('anulada');

    // ── INVARIANTE FINAL: las ventas cobradas de este servicio tienen sus pagos
    //    confirmados sumando su total, y ninguna quedó en estado intermedio raro.
    for (const vId of [v1, v2, v3, v4, v4nueva]) {
      const v = await getVenta(db, vId);
      expect(v.estado).toBe('cobrada');
      const { data: pg } = await db.from('ventas_pos_pagos').select('monto, estado').eq('venta_id', vId).is('deleted_at', null);
      const suma = (pg || []).reduce((s, p) => s + Number(p.monto), 0);
      expect(suma).toBeCloseTo(Number(v.total), 1);
    }
  });
});
