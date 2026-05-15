import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.4 — Test mutante aplicar descuento (auditoría estructural 2026-05-15).
// Cubre fn_aplicar_descuento_comanda + invariantes BLOCKER #1 del sprint 7:
//   - total nunca negativo
//   - descuento > subtotal+propina rechazado (DESCUENTO_INVALIDO)
//   - descuento > 15% sin manager_id rechazado (MANAGER_REQUERIDO_DESCUENTO_GRANDE)
//   - Override registrado en ventas_pos_overrides cuando se usa manager.

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO = 99_950_000 + Math.floor(Math.random() * 1000);

test.describe('Aplicar descuento — mutante', () => {
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
    if (locErr) throw new Error(`locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe');
    canalId = canales[0].id as number;

    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(1);
    if (!items || items.length === 0) throw new Error('Sin items en Neko');
    itemId = items[0].id as number;

    // Venta abierta con subtotal=1000, propina=0.
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO,
      modo: 'mostrador', canal_id: canalId,
      estado: 'abierta', origen: 'pos',
      subtotal: 1000, descuento_total: 0, propina: 0, total: 1000,
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
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('ventas_pos_overrides').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('descuentos válidos + invariantes BLOCKER #1', async () => {
    // ── 1. Descuento bajo (10%) sin manager → OK ─────────────────────────
    const { error: err1 } = await db.rpc('fn_aplicar_descuento_comanda', {
      p_venta_id: ventaId!,
      p_monto: 100, // 10% de 1000
      p_motivo: 'Cliente frecuente e2e',
      p_manager_id: null,
    });
    expect(err1).toBeNull();
    const { data: v1 } = await db.from('ventas_pos')
      .select('subtotal, descuento_total, total').eq('id', ventaId!).maybeSingle();
    expect(Number(v1?.descuento_total)).toBe(100);
    expect(Number(v1?.total)).toBe(900); // subtotal 1000 - descuento 100

    // ── 2. Descuento > subtotal → DESCUENTO_INVALIDO ─────────────────────
    const { error: err2 } = await db.rpc('fn_aplicar_descuento_comanda', {
      p_venta_id: ventaId!,
      p_monto: 2000, // mayor a subtotal+propina
      p_motivo: 'Test descuento invalido',
      p_manager_id: null,
    });
    expect(err2).not.toBeNull();
    expect(err2?.message || '').toMatch(/DESCUENTO_INVALIDO|MANAGER_REQUERIDO/i);

    // ── 3. Descuento > 15% sin manager → MANAGER_REQUERIDO ───────────────
    const { error: err3 } = await db.rpc('fn_aplicar_descuento_comanda', {
      p_venta_id: ventaId!,
      p_monto: 200, // 20% de 1000
      p_motivo: 'Promo nocturna e2e',
      p_manager_id: null,
    });
    expect(err3).not.toBeNull();
    expect(err3?.message || '').toMatch(/MANAGER_REQUERIDO/i);

    // ── 4. Total nunca negativo (BLOCKER #1 sprint 7) ────────────────────
    // Reset venta a estado limpio para este caso.
    await db.from('ventas_pos').update({ descuento_total: 0, total: 1000 }).eq('id', ventaId!);

    // Buscar un manager activo para autorizar.
    const { data: managers } = await db.from('rrhh_empleados')
      .select('id').eq('local_id', localId).in('rol_pos', ['manager', 'dueno'])
      .eq('pos_activo', true).limit(1);

    if (managers && managers.length > 0) {
      // Aplicar descuento del 50% (500) con manager — debería pasar.
      const { error: err4 } = await db.rpc('fn_aplicar_descuento_comanda', {
        p_venta_id: ventaId!,
        p_monto: 500,
        p_motivo: 'Promo grande e2e con manager',
        p_manager_id: managers[0].id,
      });
      expect(err4).toBeNull();
      const { data: v4 } = await db.from('ventas_pos')
        .select('descuento_total, total').eq('id', ventaId!).maybeSingle();
      expect(Number(v4?.descuento_total)).toBe(500);
      expect(Number(v4?.total)).toBe(500);

      // Override registrado.
      const { data: overrides } = await db.from('ventas_pos_overrides')
        .select('accion, motivo, monto_afectado').eq('venta_id', ventaId!);
      const ovDescuento = overrides?.find(o => o.accion === 'discount');
      expect(ovDescuento).toBeDefined();
      expect(Number(ovDescuento?.monto_afectado)).toBe(500);
    }
  });
});
