import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// Test mutante — validación de canal_id al ABRIR venta (bug 2026-07-21).
//
// Contexto: el canal_id lo elegía el frontend con `listCanales(null)` (sin
// tenant) → en sesión superadmin la RLS devuelve canales de TODOS los tenants y
// el `.find` agarraba uno ajeno/incoherente. Confirmado en prod: ventas de Neko
// con canal de otro tenant (E2E Test Suite) o con modo_pos que no matchea el
// modo de la venta. El canal malo rompe el precio del item (fn_agregar_item lee
// item_precios_canal por venta.canal_id) y el menú del POS.
//
// Fix (capa server-authoritative): fn_abrir_venta_comanda ahora valida que el
// canal exista, sea del tenant de la venta, aplique al local y tenga modo_pos
// coherente con el modo → sino RAISE 'CANAL_INVALIDO'.
//
// Invariantes:
//   1. Abrir con canal coherente del propio tenant → OK, venta.canal_id correcto.
//   2. MUTANTE modo incoherente: canal modo_pos='mostrador' con modo='pedidos'
//      → CANAL_INVALIDO (no se crea la venta).
//   3. MUTANTE canal inexistente → CANAL_INVALIDO.
//   4. MUTANTE canal de OTRO tenant (mismo modo_pos) → CANAL_INVALIDO (best-effort).
//
// DB-only, sesión dueño. Los casos de rechazo usan modo='pedidos' para saltear
// el guard NO_HAY_TURNO_ABIERTO (que aplica a salon/mostrador) — la validación
// de canal corre antes igual.

const LOCAL = 'Local Prueba 2';

test.describe('Apertura de venta — validación de canal (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalWhatsapp: number;   // pedidos, del tenant → válido para modo='pedidos'
  let canalMostrador: number;  // mostrador → incoherente con modo='pedidos'
  const ventasCreadas: number[] = [];

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
      .from('canales').select('id, slug, modo_pos')
      .eq('tenant_id', tenantId).is('deleted_at', null);
    const bySlug = (s: string) => canales?.find((c) => c.slug === s)?.id as number | undefined;
    const wa = bySlug('whatsapp');
    const mo = bySlug('mostrador');
    if (!wa) throw new Error('Canal "whatsapp" (pedidos) no existe en el tenant — falta seed');
    if (!mo) throw new Error('Canal "mostrador" no existe en el tenant — falta seed');
    canalWhatsapp = wa;
    canalMostrador = mo;
  });

  test.afterEach(async () => {
    for (const id of ventasCreadas) {
      try {
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', id);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', id);
      } catch (e) { console.error('[cleanup]', e); }
    }
    ventasCreadas.length = 0;
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('1. canal coherente del tenant → abre OK con el canal correcto', async () => {
    const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
      p_local_id: localId, p_modo: 'pedidos', p_canal_id: canalWhatsapp,
      p_origen: 'pos', p_estado: 'abierta', p_tipo_entrega: 'delivery',
    });
    expect(error).toBeNull();
    const ventaId = Number(data);
    expect(ventaId).toBeGreaterThan(0);
    ventasCreadas.push(ventaId);

    const { data: venta } = await db.from('ventas_pos')
      .select('canal_id, modo, tenant_id').eq('id', ventaId).maybeSingle();
    expect(venta?.canal_id).toBe(canalWhatsapp);
    expect(venta?.modo).toBe('pedidos');
    expect(venta?.tenant_id).toBe(tenantId);
  });

  test('2. MUTANTE modo incoherente (canal mostrador + modo pedidos) → CANAL_INVALIDO', async () => {
    const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
      p_local_id: localId, p_modo: 'pedidos', p_canal_id: canalMostrador,
      p_origen: 'pos', p_estado: 'abierta', p_tipo_entrega: 'delivery',
    });
    if (data) ventasCreadas.push(Number(data)); // por si el guard NO existe (mutante vivo)
    expect(error).not.toBeNull();
    expect(error?.message || '').toMatch(/CANAL_INVALIDO/);
  });

  test('3. MUTANTE canal inexistente → CANAL_INVALIDO', async () => {
    const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
      p_local_id: localId, p_modo: 'pedidos', p_canal_id: 999_999_999,
      p_origen: 'pos', p_estado: 'abierta', p_tipo_entrega: 'delivery',
    });
    if (data) ventasCreadas.push(Number(data));
    expect(error).not.toBeNull();
    expect(error?.message || '').toMatch(/CANAL_INVALIDO/);
  });

  test('4. MUTANTE canal de otro tenant (mismo modo_pos) → CANAL_INVALIDO', async () => {
    // best-effort: buscamos un canal 'pedidos' de OTRO tenant. Si no hay, skip.
    const { data: foraneos } = await db
      .from('canales').select('id, tenant_id, modo_pos')
      .eq('modo_pos', 'pedidos').neq('tenant_id', tenantId).is('deleted_at', null).limit(1);
    const foreign = foraneos?.[0]?.id as number | undefined;
    test.skip(!foreign, 'No hay canal pedidos de otro tenant para probar el caso cross-tenant');

    const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
      p_local_id: localId, p_modo: 'pedidos', p_canal_id: foreign!,
      p_origen: 'pos', p_estado: 'abierta', p_tipo_entrega: 'delivery',
    });
    if (data) ventasCreadas.push(Number(data));
    expect(error).not.toBeNull();
    expect(error?.message || '').toMatch(/CANAL_INVALIDO/);
  });
});
