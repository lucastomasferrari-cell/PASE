import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// Test mutante — mesa CONGELADA al facturar + destrabe por nota de crédito
// (feature 2026-07-26). DB-only, sesión dueño. NO llama a AFIP: simula los
// comprobantes insertando filas en afip_facturas directamente, para probar el
// trigger fn_bloquear_edicion_mesa_facturada (migración 202607261700).
//
// Regla de negocio: cuando una venta_pos tiene una factura electrónica activa
// (más facturas aprobadas 1/6/11 que NC aprobadas 3/8/13), no se puede
// agregar/modificar/quitar ítems. Para editarla hay que emitir una NC que la
// cancela → la venta se descongela.
//
// Invariantes:
//   1. Sin factura → se puede agregar ítem (baseline).
//   2. MUTANTE: con factura activa → INSERT de ítem falla con VENTA_FACTURADA.
//   3. MUTANTE: con factura activa → UPDATE de cantidad falla con VENTA_FACTURADA.
//   4. Insertar la NC (tipo 8) NO rompe el CHECK de tipo_comprobante (fix
//      incluido en la migración) y descongela: vuelve a poder agregarse ítem.
//
// ⚠️ Requiere la migración 202607261700 aplicada en la DB.

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO = 99_900_000 + Math.floor(Math.random() * 100_000);
const AFIP_PV = 9999; // punto de venta ficticio para no chocar con reales
const AFIP_NRO_FACTURA = SENTINEL_NUMERO;
const AFIP_NRO_NC = SENTINEL_NUMERO;

test.describe('Mesa facturada congelada + NC (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemId: number;
  let ventaId: number | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}" (falta seed)`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe en el tenant — falta seed');
    canalId = canales[0].id as number;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en el tenant — crear uno antes.');
    itemId = items[0].id as number;

    // Venta sentinel + 1 ítem (sin cobrar, sin turno: insert directo dueño).
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO,
      modo: 'mostrador', canal_id: canalId,
      estado: 'abierta', origen: 'pos', subtotal: 1000, total: 1000,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    ventaId = ventaIns?.id as number;

    const { error: iErr } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000,
      curso: 1, estado: 'hold',
    });
    if (iErr) throw new Error(`Error creando item: ${iErr.message}`);
  });

  test.afterEach(async () => {
    if (ventaId) {
      try {
        // Primero borrar los comprobantes ficticios: si quedara factura activa,
        // el propio trigger bloquearía el soft-delete de los ítems.
        await db.from('afip_facturas').delete().eq('venta_pos_id', ventaId);
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    ventaId = null;
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  async function insertarComprobante(tipo: number, numero: number) {
    return db.from('afip_facturas').insert({
      tenant_id: tenantId, venta_pos_id: ventaId,
      tipo_comprobante: tipo, punto_venta: AFIP_PV, numero,
      importe_neto: 826.45, importe_iva: 173.55, importe_total: 1000,
      concepto: 1, estado: 'aprobada',
      cae: '75000000000000', emitida_at: new Date().toISOString(),
    });
  }

  test('congela al facturar y destraba con NC', async () => {
    // ── 1. baseline: sin factura, se puede agregar ítem ───────────────────
    const { error: e1 } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId!,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000, curso: 1, estado: 'hold',
    });
    expect(e1).toBeNull();

    // ── 2. emitir "factura" (tipo 6) → mesa congelada ─────────────────────
    const { error: eFac } = await insertarComprobante(6, AFIP_NRO_FACTURA);
    expect(eFac).toBeNull();

    // MUTANTE: agregar ítem ahora debe fallar.
    const { error: e2 } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId!,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000, curso: 1, estado: 'hold',
    });
    expect(e2).not.toBeNull();
    expect(e2?.message || '').toMatch(/VENTA_FACTURADA/);

    // ── 3. MUTANTE: modificar cantidad de un ítem existente también falla ──
    const { data: existentes } = await db.from('ventas_pos_items')
      .select('id').eq('venta_id', ventaId!).is('deleted_at', null).limit(1);
    const algunItem = existentes?.[0]?.id as number;
    const { error: e3 } = await db.from('ventas_pos_items')
      .update({ cantidad: 5, subtotal: 5000 }).eq('id', algunItem);
    expect(e3).not.toBeNull();
    expect(e3?.message || '').toMatch(/VENTA_FACTURADA/);

    // ── 4. emitir NC (tipo 8) → NO rompe el CHECK y descongela ────────────
    const { error: eNc } = await insertarComprobante(8, AFIP_NRO_NC);
    expect(eNc).toBeNull(); // valida el fix del CHECK (tipo 8 aceptado)

    // Ahora factura(1) == NC(1) → no hay factura activa → editable de nuevo.
    const { error: e4 } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId!,
      item_id: itemId, cantidad: 1, precio_unitario: 1000, subtotal: 1000, curso: 1, estado: 'hold',
    });
    expect(e4).toBeNull();
  });
});
