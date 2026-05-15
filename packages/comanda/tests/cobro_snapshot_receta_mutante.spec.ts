import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// F1.1c — Test mutante snapshot receta al cobrar venta.
//
// Cierra el hueco que dejaba el test `cobro_efectivo_mutante.spec.ts`: no
// validaba que `fn_cobrar_venta_comanda` setteara `ventas_pos_items.
// receta_version_id` con la versión inmutable de la receta vigente al
// momento del cobro.
//
// Invariantes que valida (todas con asserts DB-only `toBe`):
//   1. Venta cobrada con item que tiene receta viva → cada item del cobro
//      queda con `receta_version_id` != NULL apuntando a una fila de
//      `recetas_versiones` con `item_id` correcto y `receta_data` JSON
//      consistente con la receta vigente al momento del cobro.
//   2. Inmutabilidad: si después del cobro se modifica la receta viva
//      (update receta_insumos), el `receta_version_id` de la venta
//      cobrada **NO cambia** y la version_data sigue reflejando lo que
//      había al cobrar.
//   3. Items SIN receta: el campo `receta_version_id` queda NULL y el
//      cobro NO falla (snapshot es best-effort).
//   4. Idempotency del snapshot: re-llamar fn_cobrar_venta_comanda con la
//      misma idempotency_key NO crea una versión nueva (la venta ya
//      cobrada retorna sin re-snapshotear).

const LOCAL = 'Local Prueba 2';
const SENTINEL_NUMERO = 99_910_000 + Math.floor(Math.random() * 1000);
const SENTINEL_INSUMO = `Test-F11c-INS-${Date.now()}`;
const SENTINEL_RECETA = `Test-F11c-REC-${Date.now()}`;

test.describe('F1.1c — snapshot receta al cobrar venta (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let canalId: number;
  let itemConRecetaId: number;
  let itemSinRecetaId: number;
  let turnoId: number | null = null;
  let ventaId: number | null = null;
  let insumoId: number | null = null;
  let recetaId: number | null = null;
  let recetaInsumoId: number | null = null;
  let snapshotIdsCreated: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();

    // Local Prueba 2
    const { data: locales } = await db.from('locales').select('id, tenant_id').eq('nombre', LOCAL);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // Canal mostrador
    const { data: canales } = await db
      .from('canales').select('id').eq('tenant_id', tenantId).eq('slug', 'mostrador').limit(1);
    if (!canales || canales.length === 0) throw new Error('Canal "mostrador" no existe en Neko');
    canalId = canales[0]!.id as number;

    // Dos items distintos: uno tendrá receta, el otro NO
    const { data: items } = await db
      .from('items').select('id').eq('tenant_id', tenantId).limit(2);
    if (!items || items.length < 2) throw new Error('Necesito al menos 2 items en Neko');
    itemConRecetaId = items[0]!.id as number;
    itemSinRecetaId = items[1]!.id as number;

    // Insumo sentinel
    const { data: ins, error: errIns } = await db.from('insumos').insert({
      tenant_id: tenantId, local_id: localId,
      nombre: SENTINEL_INSUMO, unidad: 'kg',
      costo_actual: 1000.00, es_comprado: true,
    }).select('id').single();
    if (errIns) throw new Error(`Error creando insumo: ${errIns.message}`);
    insumoId = ins!.id as number;

    // Receta sentinel para itemConRecetaId
    const { data: rec, error: errRec } = await db.from('recetas').insert({
      tenant_id: tenantId, local_id: localId,
      item_id: itemConRecetaId, nombre: SENTINEL_RECETA,
      rendimiento: 1, activa: true,
    }).select('id').single();
    if (errRec) throw new Error(`Error creando receta: ${errRec.message}`);
    recetaId = rec!.id as number;

    const { data: ri, error: errRi } = await db.from('receta_insumos').insert({
      tenant_id: tenantId,
      receta_id: recetaId, insumo_id: insumoId,
      cantidad: 0.5, merma_pct: 10, orden: 1,
    }).select('id').single();
    if (errRi) throw new Error(`Error creando receta_insumo: ${errRi.message}`);
    recetaInsumoId = ri!.id as number;

    // Turno abierto (re-usar si hay, sino abrir)
    const { data: turnoExistente } = await db
      .from('turnos_caja').select('id').eq('local_id', localId).eq('estado', 'abierto')
      .order('id', { ascending: false }).limit(1);
    if (turnoExistente && turnoExistente.length > 0) {
      turnoId = turnoExistente[0]!.id as number;
    } else {
      const { data: emp } = await db
        .from('rrhh_empleados').select('id').eq('local_id', localId).eq('pos_activo', true).limit(1);
      if (!emp || emp.length === 0) throw new Error('Sin empleado POS activo en Local Prueba 2');
      const { data: turnoData, error: turnoErr } = await db.rpc('fn_abrir_turno_caja_comanda', {
        p_local_id: localId, p_cajero_id: emp[0]!.id, p_monto_inicial: 0, p_notas: 'e2e f1.1c',
      });
      if (turnoErr) throw new Error(`Error abriendo turno: ${turnoErr.message}`);
      turnoId = Number(turnoData);
    }

    // Crear venta con 2 items: uno con receta, otro sin
    const { data: ventaIns, error: vErr } = await db.from('ventas_pos').insert({
      tenant_id: tenantId, local_id: localId,
      numero_local: SENTINEL_NUMERO,
      modo: 'mostrador', canal_id: canalId, turno_caja_id: turnoId,
      estado: 'abierta', origen: 'pos', subtotal: 2000, total: 2000,
    }).select('id').single();
    if (vErr) throw new Error(`Error creando venta: ${vErr.message}`);
    ventaId = ventaIns!.id as number;

    const { error: i1Err } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemConRecetaId, cantidad: 1, precio_unitario: 1000, subtotal: 1000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
    if (i1Err) throw new Error(`Error item-con-receta: ${i1Err.message}`);

    const { error: i2Err } = await db.from('ventas_pos_items').insert({
      tenant_id: tenantId, local_id: localId, venta_id: ventaId,
      item_id: itemSinRecetaId, cantidad: 1, precio_unitario: 1000, subtotal: 1000,
      curso: 1, estado: 'enviado', enviado_at: new Date().toISOString(),
    });
    if (i2Err) throw new Error(`Error item-sin-receta: ${i2Err.message}`);
  });

  test.afterEach(async () => {
    // Cleanup en orden inverso. Cada paso en try/catch.
    if (ventaId) {
      try {
        // Recolectar snapshot ids creados via la venta para borrar al final
        const { data: vpi } = await db.from('ventas_pos_items')
          .select('receta_version_id').eq('venta_id', ventaId);
        for (const r of vpi ?? []) {
          if (r.receta_version_id) snapshotIdsCreated.push(r.receta_version_id);
        }
        await db.from('ventas_pos_items').update({ deleted_at: new Date().toISOString(), receta_version_id: null }).eq('venta_id', ventaId);
        await db.from('ventas_pos_pagos').update({ deleted_at: new Date().toISOString() }).eq('venta_id', ventaId);
        await db.from('movimientos_caja').delete().eq('venta_id', ventaId);
        await db.from('ventas_pos').update({ deleted_at: new Date().toISOString(), estado: 'anulada' }).eq('id', ventaId);
      } catch (e) { console.error('[cleanup venta]', e); }
    }
    // Borrar snapshots creados (recetas_versiones)
    for (const sid of [...new Set(snapshotIdsCreated)]) {
      try { await db.from('recetas_versiones').delete().eq('id', sid); }
      catch (e) { console.error('[cleanup recetas_versiones]', e); }
    }
    if (recetaInsumoId) {
      try { await db.from('receta_insumos').update({ deleted_at: new Date().toISOString() }).eq('id', recetaInsumoId); }
      catch (e) { console.error('[cleanup ri]', e); }
    }
    if (recetaId) {
      try { await db.from('recetas').update({ deleted_at: new Date().toISOString(), activa: false }).eq('id', recetaId); }
      catch (e) { console.error('[cleanup receta]', e); }
    }
    if (insumoId) {
      try { await db.from('insumos').update({ deleted_at: new Date().toISOString() }).eq('id', insumoId); }
      catch (e) { console.error('[cleanup insumo]', e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('cobro snapshotea receta_version_id por item + inmutabilidad post-cobro', async () => {
    // ── 1. Cobrar venta ───────────────────────────────────────────────────
    const idemKey = `e2e-f11c-${ventaId}-${Date.now()}`;
    const { data: totalCobrado, error: errCobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 2000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: idemKey,
    });
    expect(errCobro).toBeNull();
    expect(Number(totalCobrado)).toBe(2000);

    // ── 2. Item con receta tiene receta_version_id != NULL ────────────────
    const { data: vpi } = await db.from('ventas_pos_items')
      .select('id, item_id, receta_version_id')
      .eq('venta_id', ventaId!).order('id');
    expect(vpi?.length).toBe(2);

    const itemConRec = vpi?.find(x => x.item_id === itemConRecetaId);
    const itemSinRec = vpi?.find(x => x.item_id === itemSinRecetaId);
    expect(itemConRec?.receta_version_id).not.toBeNull();
    expect(itemConRec?.receta_version_id).toBeGreaterThan(0);

    // ── 3. Item sin receta tiene receta_version_id == NULL ────────────────
    expect(itemSinRec?.receta_version_id).toBeNull();

    const versionIdInicial = itemConRec!.receta_version_id as number;
    snapshotIdsCreated.push(versionIdInicial);

    // ── 4. La versión guardada en recetas_versiones tiene contenido correcto
    const { data: rv } = await db.from('recetas_versiones')
      .select('item_id, version_numero, receta_data')
      .eq('id', versionIdInicial).maybeSingle();
    expect(rv?.item_id).toBe(itemConRecetaId);
    expect(rv?.version_numero).toBeGreaterThanOrEqual(1);
    const data = rv?.receta_data as { receta_id: number; insumos: Array<{ insumo_id: number; cantidad: number }> };
    expect(data.receta_id).toBe(recetaId);
    expect(data.insumos.length).toBe(1);
    expect(data.insumos[0]!.insumo_id).toBe(insumoId);
    expect(Number(data.insumos[0]!.cantidad)).toBe(0.5);

    // ── 5. INMUTABILIDAD: modificar receta NO afecta la versión del cobro ─
    const { error: errUpd } = await db.from('receta_insumos')
      .update({ cantidad: 99.99 }).eq('id', recetaInsumoId!);
    expect(errUpd).toBeNull();

    // Re-leer el item de la venta cobrada — DEBE seguir apuntando a la version vieja
    const { data: vpiPost } = await db.from('ventas_pos_items')
      .select('receta_version_id').eq('id', itemConRec!.id).maybeSingle();
    expect(vpiPost?.receta_version_id).toBe(versionIdInicial);

    // El contenido de esa version también debe seguir igual (cantidad 0.5, NO 99.99)
    const { data: rvPost } = await db.from('recetas_versiones')
      .select('receta_data').eq('id', versionIdInicial).maybeSingle();
    const dataPost = rvPost?.receta_data as { insumos: Array<{ cantidad: number }> };
    expect(Number(dataPost.insumos[0]!.cantidad)).toBe(0.5);

    // ── 6. IDEMPOTENCY: 2do call mismo key → NO re-snapshotea ─────────────
    const { error: errRecobro } = await db.rpc('fn_cobrar_venta_comanda', {
      p_venta_id: ventaId!,
      p_pagos: [{ metodo: 'efectivo', monto: 2000 }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: idemKey,
    });
    expect(errRecobro).toBeNull();

    // Verificar que NO se creó una version nueva — el item sigue apuntando a la misma
    const { data: vpiFinal } = await db.from('ventas_pos_items')
      .select('receta_version_id').eq('id', itemConRec!.id).maybeSingle();
    expect(vpiFinal?.receta_version_id).toBe(versionIdInicial);
  });
});
