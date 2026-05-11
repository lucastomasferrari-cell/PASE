import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: pagar 2 facturas con un solo egreso MP via fn_conciliar_mp_con_facturas.
//
// Patrón distinto al resto de la suite mutante: DB-only (no UI). La RPC es
// el corazón de la atomicidad — si funciona, la integración UI ↔ RPC es
// cubierta por typecheck + lint + build. El flow UI del modo multi-factura
// es muy verboso de instrumentar con selectores frágiles, y el riesgo de
// atomicidad (que es lo que un test mutante valida) está 100% en la RPC.
//
// Lo que el test valida (efectos de fn_conciliar_mp_con_facturas):
//   1. mp_movimientos.justificativo_tipo = 'multi_factura', id NULL.
//   2. 2 filas en mp_movimiento_facturas con monto_aplicado correcto.
//   3. Ambas facturas: factura.pagos JSONB con entry tipo MP + factura.estado='pagada'.
//   4. 1 movimiento contable por la SUMA aplicada (no por monto MP).
//   5. saldos_caja MP bajó por el MONTO MP COMPLETO (no por la suma).
//   6. proveedores.saldo decrementado por la suma aplicada.
//   7. idempotency_keys: 2da llamada con misma key devuelve cacheado.
const SENTINEL_MP = 100000;          // monto egreso MP
const SENTINEL_F1 = 30000;           // factura 1
const SENTINEL_F2 = 70000;           // factura 2 — suma exacta (100k = 100k)
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const CUENTA_MP = "MercadoPago";

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe("Conciliación MP — multi-factura mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let provId: number;
  let saldoMpInicial: number;
  let saldoProvInicial: number;
  let mpMovId: string | null = null;
  let facturaId1: string | null = null;
  let facturaId2: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: provs, error: provErr } = await db
      .from("proveedores").select("id, saldo").eq("nombre", PROVEEDOR);
    if (provErr) throw new Error(`Error consultando proveedores: ${provErr.message}`);
    if (!provs || provs.length === 0) {
      throw new Error(
        `Falta proveedor "${PROVEEDOR}" en el tenant Neko. Crearlo con:\n` +
        `INSERT INTO proveedores (nombre, tenant_id, saldo, estado) ` +
        `VALUES ('${PROVEEDOR}', '${tenantId}', 0, 'Activo');`
      );
    }
    if (provs.length > 1) throw new Error(`Hay ${provs.length} proveedores con nombre "${PROVEEDOR}" — desambiguar`);
    provId = provs[0].id as number;
    saldoProvInicial = (provs[0].saldo as number | null) ?? 0;

    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA_MP).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA_MP}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) VALUES ('${CUENTA_MP}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoMpInicial = saldoRow.saldo as number;

    // Insertar 2 facturas sandbox (pendientes) del mismo proveedor.
    facturaId1 = genId("FACT");
    facturaId2 = genId("FACT");
    const nro1 = `E2E-MF1-${Date.now()}`;
    const nro2 = `E2E-MF2-${Date.now()}`;
    const { error: insFac1 } = await db.from("facturas").insert([{
      id: facturaId1, prov_id: provId, local_id: localId, nro: nro1,
      fecha: todayISO(), total: SENTINEL_F1, neto: SENTINEL_F1,
      iva21: 0, iva105: 0, iibb: 0, perc_iva: 0, otros_cargos: 0, descuentos: 0,
      estado: "pendiente", pagos: [], tipo: "factura", tenant_id: tenantId,
    }]);
    if (insFac1) throw new Error(`Insert factura 1: ${insFac1.message}`);
    const { error: insFac2 } = await db.from("facturas").insert([{
      id: facturaId2, prov_id: provId, local_id: localId, nro: nro2,
      fecha: todayISO(), total: SENTINEL_F2, neto: SENTINEL_F2,
      iva21: 0, iva105: 0, iibb: 0, perc_iva: 0, otros_cargos: 0, descuentos: 0,
      estado: "pendiente", pagos: [], tipo: "factura", tenant_id: tenantId,
    }]);
    if (insFac2) throw new Error(`Insert factura 2: ${insFac2.message}`);

    // Insertar mp_movimiento sandbox (egreso).
    mpMovId = `mock-e2e-mf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { error: insMp } = await db.from("mp_movimientos").insert([{
      id: mpMovId, local_id: localId, tenant_id: tenantId,
      fecha: new Date().toISOString(),
      tipo: "bank_transfer",
      descripcion: `E2E multi-factura ${Date.now()}`,
      monto: -SENTINEL_MP,
      estado: "approved",
      conciliado: false,
      anulado: false,
    }]);
    if (insMp) throw new Error(`Insert mp_movimiento: ${insMp.message}`);

    movId = null;
  });

  test.afterEach(async () => {
    if (movId) {
      try { const { error } = await db.from("movimientos").delete().eq("id", movId);
        if (error) console.error(`[cleanup] delete mov: ${error.message}`);
      } catch (e) { console.error(`[cleanup] delete mov threw:`, e); }
    }
    if (mpMovId) {
      try { const { error } = await db.from("mp_movimiento_facturas").delete().eq("mp_mov_id", mpMovId);
        if (error) console.error(`[cleanup] delete bridge: ${error.message}`);
      } catch (e) { console.error(`[cleanup] delete bridge threw:`, e); }
    }
    for (const fId of [facturaId1, facturaId2]) {
      if (fId) {
        try { const { error } = await db.from("facturas").delete().eq("id", fId);
          if (error) console.error(`[cleanup] delete factura(${fId}): ${error.message}`);
        } catch (e) { console.error(`[cleanup] delete factura threw:`, e); }
      }
    }
    if (mpMovId) {
      try { const { error } = await db.from("mp_movimientos").delete().eq("id", mpMovId);
        if (error) console.error(`[cleanup] delete mp_mov: ${error.message}`);
      } catch (e) { console.error(`[cleanup] delete mp_mov threw:`, e); }
    }
    // Limpiar idempotency_keys generadas (en caso de que el test falle antes).
    try { await db.from("idempotency_keys").delete().like("key", "test-mf-%"); } catch { /* idempotente */ }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("conciliar 1 MP contra 2 facturas: tabla puente + pagos + estado + saldos + idempotency", async () => {
    const idempKey = `test-mf-${Date.now()}`;
    const { data: rpcRes, error: rpcErr } = await db.rpc("fn_conciliar_mp_con_facturas", {
      p_mp_mov_id: mpMovId,
      p_lineas: [
        { factura_id: facturaId1, monto_aplicado: SENTINEL_F1 },
        { factura_id: facturaId2, monto_aplicado: SENTINEL_F2 },
      ],
      p_idempotency_key: idempKey,
    });
    expect(rpcErr).toBeNull();
    expect(rpcRes).not.toBeNull();
    movId = (rpcRes as { mov_id: string }).mov_id;
    expect((rpcRes as { total_aplicado: number }).total_aplicado).toBe(SENTINEL_F1 + SENTINEL_F2);
    expect((rpcRes as { monto_mp: number }).monto_mp).toBe(SENTINEL_MP);
    expect((rpcRes as { diferencia: number }).diferencia).toBe(0);

    // ── Assert 1: mp_movimientos.justificativo_tipo='multi_factura' ─────
    const { data: mpRows } = await db
      .from("mp_movimientos")
      .select("id, justificativo_tipo, justificativo_id, justificativo_at")
      .eq("id", mpMovId);
    expect(mpRows?.[0]?.justificativo_tipo).toBe("multi_factura");
    expect(mpRows?.[0]?.justificativo_id).toBeNull();
    expect(mpRows?.[0]?.justificativo_at).not.toBeNull();

    // ── Assert 2: tabla puente con 2 filas ──────────────────────────────
    const { data: bridge } = await db
      .from("mp_movimiento_facturas")
      .select("factura_id, monto_aplicado, tenant_id")
      .eq("mp_mov_id", mpMovId)
      .order("factura_id");
    expect(bridge?.length).toBe(2);
    const totales = new Map((bridge || []).map(b => [b.factura_id as string, Number(b.monto_aplicado)]));
    expect(totales.get(facturaId1!)).toBe(SENTINEL_F1);
    expect(totales.get(facturaId2!)).toBe(SENTINEL_F2);
    expect(bridge?.[0]?.tenant_id).toBe(tenantId);

    // ── Assert 3: ambas facturas pagadas con pagos JSONB ───────────────
    const { data: facsAfter } = await db
      .from("facturas").select("id, estado, pagos, total")
      .in("id", [facturaId1, facturaId2]);
    expect(facsAfter?.length).toBe(2);
    for (const f of facsAfter || []) {
      expect(f.estado).toBe("pagada");
      const pagos = (f.pagos || []) as Array<{ cuenta: string; monto: number; mp_mov_id?: string }>;
      expect(pagos.length).toBe(1);
      expect(pagos[0]?.cuenta).toBe(CUENTA_MP);
      expect(pagos[0]?.mp_mov_id).toBe(mpMovId);
      expect(pagos[0]?.monto).toBe(Number(f.total));
    }

    // ── Assert 4: 1 movimiento contable por el TOTAL APLICADO ──────────
    const { data: movs } = await db
      .from("movimientos").select("id, cuenta, importe, tipo, cat")
      .eq("id", movId);
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.cuenta).toBe(CUENTA_MP);
    expect(movs?.[0]?.importe).toBe(-(SENTINEL_F1 + SENTINEL_F2));
    expect(movs?.[0]?.tipo).toBe("Conciliación MP - Multi-factura");

    // ── Assert 5: saldos_caja MP bajó por MONTO MP COMPLETO ────────────
    const { data: saldoFinal } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA_MP).eq("local_id", localId).maybeSingle();
    expect(saldoFinal?.saldo).toBe(saldoMpInicial - SENTINEL_MP);

    // ── Assert 6: proveedores.saldo decrementado por suma aplicada ─────
    // Inicial = saldoProvInicial. INSERTs subieron por F1+F2. Pagos
    // bajaron por F1+F2. Final = saldoProvInicial.
    const { data: provFinal } = await db
      .from("proveedores").select("saldo").eq("id", provId).maybeSingle();
    expect(provFinal?.saldo).toBe(saldoProvInicial);

    // ── Assert 7: idempotency — 2da llamada con misma key devuelve cacheado ─
    const { data: rpc2Res, error: rpc2Err } = await db.rpc("fn_conciliar_mp_con_facturas", {
      p_mp_mov_id: mpMovId,
      p_lineas: [{ factura_id: facturaId1, monto_aplicado: SENTINEL_F1 }],   // distinto al original
      p_idempotency_key: idempKey,
    });
    expect(rpc2Err).toBeNull();
    expect((rpc2Res as { total_aplicado: number }).total_aplicado).toBe(SENTINEL_F1 + SENTINEL_F2); // valor del primer call
    // El tabla puente sigue con 2 filas (no duplicó).
    const { data: bridgeAfter } = await db
      .from("mp_movimiento_facturas").select("id").eq("mp_mov_id", mpMovId);
    expect(bridgeAfter?.length).toBe(2);
  });
});
