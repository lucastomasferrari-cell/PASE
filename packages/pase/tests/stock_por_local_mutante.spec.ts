import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: stock por local + fecha real de compra (Tier 1 #1 y #5).
// Plan: docs/superpowers/plans/2026-06-11-stock-por-local-y-fecha-compras.md
//
// Valida (migraciones 202606120100 / 202606120110 / 202606120120):
//   1. Compra por factura (factura_item con materia_prima_id) entra al
//      LOCAL de la factura → fila en insumo_stock_local(insumo, localA).
//   2. El otro local NO recibe nada (sin fila o cantidad 0).
//   3. insumos.stock_actual sigue siendo el total GLOBAL del tenant.
//   4. El movimiento entrada_compra queda fechado con la FECHA DE LA
//      FACTURA (retroactiva), no con la fecha de carga.
//   5. fn_transferir_stock_local A→B mueve los saldos per-local sin tocar
//      el global.
//   6. Merma en B descuenta del saldo de B.
//   7. Transferencia que excede el saldo del ORIGEN falla con
//      STOCK_INSUFICIENTE aunque el stock global alcance.
//   8. fn_cmv_real del local A devuelve compras y stock_final coherentes.
//
// DB-only. Sentinels numéricos distintivos, limpieza en afterEach con cada
// paso en su propio try/catch.
// ─────────────────────────────────────────────────────────────────────────

const SENTINEL = `ZZMUTSTKLOC-${Date.now()}`;
const LOCAL_A = "Local Prueba 2";

// Sentinels del plan
const QTY_COMPRA = 7.7301; // entra al local A vía factura
const QTY_TRANSFER = 2.1101; // A → B
const QTY_MERMA = 1.0701; // sale de B
const QTY_EXCESO = 3.5; // > saldo de B post-merma, < stock global
const FECHA_FACTURA = "2026-06-01"; // fecha retroactiva (Cambio B)
const PRECIO_KG = 1000;

test.describe("Stock por local + fecha de compra (mutante)", () => {
  let db: SupabaseClient;
  let tenantId: string;
  let localA: number;
  let localB: number;
  let insumoId: number | null = null;
  let mpId: number | null = null;
  let proveedorId: number | null = null;
  let facturaId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL_A);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL_A}" no único`);
    localA = locs[0]!.id as number;
    tenantId = locs[0]!.tenant_id as string;

    // Local B: cualquier OTRO local del tenant de test.
    const { data: otros } = await db
      .from("locales")
      .select("id, nombre")
      .eq("tenant_id", tenantId)
      .neq("id", localA)
      .order("id")
      .limit(1);
    if (!otros || otros.length === 0) {
      throw new Error(
        `Seed faltante: el tenant de "${LOCAL_A}" necesita un SEGUNDO local para probar transferencias. Crear otro local de prueba en ese tenant.`
      );
    }
    localB = otros[0]!.id as number;

    // Proveedor del tenant (seed estándar: Proveedor Prueba; fallback any).
    const { data: provs } = await db
      .from("proveedores")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1);
    proveedorId = provs?.[0]?.id ?? null;
    if (proveedorId === null) {
      throw new Error("Seed faltante: no hay proveedores en el tenant de test (crear 'Proveedor Prueba').");
    }

    insumoId = null;
    mpId = null;
    facturaId = null;
  });

  test.afterEach(async () => {
    // Cleanup en orden inverso, cada paso en su propio try/catch.
    if (facturaId) {
      try {
        await db.from("factura_items").delete().eq("factura_id", facturaId);
        await db.from("facturas").delete().eq("id", facturaId);
      } catch (e) {
        console.error("[cleanup factura]", e);
      }
    }
    if (insumoId) {
      try {
        await db.from("stock_transferencias").delete().eq("insumo_id", insumoId);
      } catch (e) {
        console.error("[cleanup transferencias]", e);
      }
      try {
        await db.from("insumo_movimientos").delete().eq("insumo_id", insumoId);
      } catch (e) {
        console.error("[cleanup movimientos]", e);
      }
      try {
        // Reconstruye stock_actual + insumo_stock_local desde el ledger (vacío).
        await db.rpc("fn_recalcular_stock_insumo", { p_insumo_id: insumoId });
      } catch (e) {
        console.error("[cleanup recalc]", e);
      }
    }
    if (mpId) {
      try {
        await db
          .from("materias_primas")
          .update({ deleted_at: new Date().toISOString(), activa: false })
          .eq("id", mpId);
      } catch (e) {
        console.error("[cleanup mp]", e);
      }
    }
    if (insumoId) {
      try {
        await db
          .from("insumos")
          .update({ deleted_at: new Date().toISOString(), activo: false })
          .eq("id", insumoId);
      } catch (e) {
        console.error("[cleanup insumo]", e);
      }
    }
    try {
      await db.auth.signOut();
    } catch {
      /* idempotente */
    }
  });

  // Helpers de lectura DB-only ───────────────────────────────────────────
  const stockGlobal = async (): Promise<string> => {
    const { data } = await db.from("insumos").select("stock_actual").eq("id", insumoId!).single();
    return Number(data!.stock_actual ?? 0).toFixed(4);
  };

  const stockLocal = async (localId: number): Promise<string> => {
    const { data } = await db
      .from("insumo_stock_local")
      .select("cantidad")
      .eq("insumo_id", insumoId!)
      .eq("local_id", localId);
    if (!data || data.length === 0) return (0).toFixed(4);
    return Number(data[0]!.cantidad ?? 0).toFixed(4);
  };

  test("compra entra al local de la factura con SU fecha, transferencia y merma mueven saldos per-local, exceso rechaza", async () => {
    // ── Setup: insumo + materia prima vinculada (factor 1, merma 0) ──────
    const { data: ins, error: errIns } = await db
      .from("insumos")
      .insert({
        tenant_id: tenantId,
        local_id: localA,
        nombre: `${SENTINEL}-Insumo`,
        unidad: "kg",
        es_comprado: true,
        activo: true,
        stock_disponible: true,
        costo_actual: PRECIO_KG,
      })
      .select("id")
      .single();
    expect(errIns).toBeNull();
    insumoId = ins!.id as number;

    const { data: mp, error: errMp } = await db
      .from("materias_primas")
      .insert({
        tenant_id: tenantId,
        nombre: `${SENTINEL}-MP`,
        proveedor_id: proveedorId,
        insumo_id: insumoId,
        unidad_compra: "kg",
        factor_conversion: 1,
        precio_actual: PRECIO_KG,
        activa: true,
      })
      .select("id")
      .single();
    expect(errMp).toBeNull();
    mpId = mp!.id as number;

    // ── 1+2. Factura en localA con fecha RETROACTIVA + item mapeado a MP ─
    //         (el trigger fn_trg_factura_item_entrada_stock crea la entrada)
    const idFact = `FACT-STKLOC-${Date.now()}`;
    const { error: errFact } = await db.from("facturas").insert({
      id: idFact,
      tenant_id: tenantId,
      local_id: localA,
      prov_id: proveedorId,
      nro: `STKLOC-${Date.now()}`,
      fecha: FECHA_FACTURA,
      neto: QTY_COMPRA * PRECIO_KG,
      total: QTY_COMPRA * PRECIO_KG,
      estado: "pendiente",
    });
    expect(errFact).toBeNull();
    facturaId = idFact;

    const { error: errFi } = await db.from("factura_items").insert({
      factura_id: idFact,
      tenant_id: tenantId,
      producto: `${SENTINEL} compra test`,
      cantidad: QTY_COMPRA,
      unidad: "kg",
      precio_unitario: PRECIO_KG,
      subtotal: QTY_COMPRA * PRECIO_KG,
      materia_prima_id: mpId,
    });
    expect(errFi).toBeNull();

    // ASSERT Cambio A: la compra entró al local de la factura…
    expect(await stockLocal(localA)).toBe(QTY_COMPRA.toFixed(4));
    // …y NO al otro local.
    expect(await stockLocal(localB)).toBe((0).toFixed(4));
    // El global sigue siendo el total del tenant.
    expect(await stockGlobal()).toBe(QTY_COMPRA.toFixed(4));

    // ── 4. ASSERT Cambio B: el movimiento está fechado con la factura ────
    const { data: movs } = await db
      .from("insumo_movimientos")
      .select("id, tipo, local_id, cantidad, created_at")
      .eq("insumo_id", insumoId)
      .eq("fuente_tipo", "factura_item")
      .is("deleted_at", null);
    expect(movs).not.toBeNull();
    expect(movs!.length).toBe(1);
    const mov = movs![0]!;
    expect(mov.tipo).toBe("entrada_compra");
    expect(mov.local_id).toBe(localA);
    expect(Number(mov.cantidad).toFixed(4)).toBe(QTY_COMPRA.toFixed(4));
    // created_at = fecha de la FACTURA (retroactiva), no la fecha de carga.
    expect(String(mov.created_at).slice(0, 10)).toBe(FECHA_FACTURA);

    // ── 5. Transferencia A→B mueve per-local sin tocar el global ─────────
    const { error: errTr } = await db.rpc("fn_transferir_stock_local", {
      p_insumo_id: insumoId,
      p_local_origen_id: localA,
      p_local_destino_id: localB,
      p_cantidad: QTY_TRANSFER,
      p_motivo: "mutante stock por local",
    });
    expect(errTr).toBeNull();
    expect(await stockLocal(localA)).toBe((QTY_COMPRA - QTY_TRANSFER).toFixed(4));
    expect(await stockLocal(localB)).toBe(QTY_TRANSFER.toFixed(4));
    expect(await stockGlobal()).toBe(QTY_COMPRA.toFixed(4)); // global sin cambio

    // ── 6. Merma en B descuenta de B ──────────────────────────────────────
    const { data: mot } = await db
      .from("mermas_motivos")
      .select("id, tipo_movimiento")
      .eq("tenant_id", tenantId)
      .eq("activo", true)
      .is("deleted_at", null)
      .neq("tipo_movimiento", "robo") // robo exige manager override
      .limit(1);
    const motivoId = mot?.[0]?.id as number | undefined;
    if (!motivoId) {
      throw new Error("Seed faltante: no hay mermas_motivos activos (no-robo) en el tenant de test.");
    }
    const { error: errMerma } = await db.rpc("fn_registrar_merma", {
      p_insumo_id: insumoId,
      p_local_id: localB,
      p_cantidad: QTY_MERMA,
      p_motivo_id: motivoId,
      p_notas: "mutante stock por local",
    });
    expect(errMerma).toBeNull();
    expect(await stockLocal(localB)).toBe((QTY_TRANSFER - QTY_MERMA).toFixed(4));
    expect(await stockLocal(localA)).toBe((QTY_COMPRA - QTY_TRANSFER).toFixed(4)); // A intacto
    expect(await stockGlobal()).toBe((QTY_COMPRA - QTY_MERMA).toFixed(4));

    // ── 7. Transferencia que excede el saldo del ORIGEN (B) rechaza ───────
    //       aunque el stock GLOBAL alcance (global ≈ 6.66 > 3.5 > saldo B ≈ 1.04).
    expect(QTY_COMPRA - QTY_MERMA).toBeGreaterThan(QTY_EXCESO); // sanity: global alcanza
    expect(QTY_TRANSFER - QTY_MERMA).toBeLessThan(QTY_EXCESO); // sanity: B no alcanza
    const { error: errExceso } = await db.rpc("fn_transferir_stock_local", {
      p_insumo_id: insumoId,
      p_local_origen_id: localB,
      p_local_destino_id: localA,
      p_cantidad: QTY_EXCESO,
      p_motivo: "debe fallar",
    });
    expect(errExceso).not.toBeNull();
    expect(errExceso!.message).toContain("STOCK_INSUFICIENTE");
    // Saldos intactos tras el rechazo.
    expect(await stockLocal(localA)).toBe((QTY_COMPRA - QTY_TRANSFER).toFixed(4));
    expect(await stockLocal(localB)).toBe((QTY_TRANSFER - QTY_MERMA).toFixed(4));

    // ── 8. fn_cmv_real del local A coherente con los sentinels ────────────
    //       hasta = pasado mañana (evita edge TZ: created_at::DATE se computa
    //       en UTC y el test puede correr de noche en ART).
    const hasta = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: cmv, error: errCmv } = await db.rpc("fn_cmv_real", {
      p_tenant_id: tenantId,
      p_local_id: localA,
      p_desde: FECHA_FACTURA,
      p_hasta: hasta,
    });
    expect(errCmv).toBeNull();
    const fila = (cmv as Array<Record<string, unknown>> | null)?.find((r) => Number(r.insumo_id) === insumoId);
    expect(fila).toBeTruthy();
    expect(Number(fila!.stock_inicial).toFixed(4)).toBe((0).toFixed(4));
    expect(Number(fila!.compras_cantidad).toFixed(4)).toBe(QTY_COMPRA.toFixed(4));
    expect(Number(fila!.mermas_cantidad).toFixed(4)).toBe((0).toFixed(4)); // la merma fue en B
    expect(Number(fila!.stock_final).toFixed(4)).toBe((QTY_COMPRA - QTY_TRANSFER).toFixed(4));
  });
});
