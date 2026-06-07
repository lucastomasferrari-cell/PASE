import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: stock — merma + conteo ciego (Pieza C).
// Spec: docs/superpowers/specs/2026-05-28-stock-cmv-avt-rediseno.md
//
// Valida:
//   - entrada de stock (movimiento) actualiza insumos.stock_actual (trigger).
//   - fn_registrar_merma descuenta stock.
//   - fn_iniciar_conteo_fisico snapshotea el teórico.
//   - fn_cargar_conteo_linea + fn_finalizar_conteo_fisico computan la diferencia
//     real (contado − teórico) y aplican el ajuste al stock.
//
// DB-only. Insumo con prefijo SENTINEL, limpieza en afterEach.
// ─────────────────────────────────────────────────────────────────────────
const SENT = "ZZMUTSTOCK";
const LOCAL = "Local Prueba 2";

test.describe("Stock — merma + conteo ciego (mutante)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let insumoId: number | undefined;
  let conteoId: number | undefined;
  let motivoId: number | undefined;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;
    // Limpiar conteos abiertos previos del local (evita CONTEO_YA_ABIERTO).
    const { data: abiertos } = await db.from("stock_conteos").select("id").eq("local_id", localId).eq("estado", "abierto");
    for (const a of abiertos || []) {
      await db.from("stock_conteo_lineas").delete().eq("conteo_id", a.id as number).then(() => {}, () => {});
      await db.from("stock_conteos").delete().eq("id", a.id as number).then(() => {}, () => {});
    }
    const { data: mot } = await db.from("mermas_motivos").select("id").eq("activo", true).is("deleted_at", null).limit(1);
    motivoId = mot?.[0]?.id as number;
    insumoId = undefined; conteoId = undefined;
  });

  test.afterEach(async () => {
    if (conteoId) {
      await db.from("stock_conteo_lineas").delete().eq("conteo_id", conteoId).then(() => {}, () => {});
      await db.from("stock_conteos").delete().eq("id", conteoId).then(() => {}, () => {});
    }
    if (insumoId) {
      await db.from("insumo_movimientos").delete().eq("insumo_id", insumoId).then(() => {}, () => {});
      await db.from("insumos").delete().eq("id", insumoId).then(() => {}, () => {});
    }
    try { await db.auth.signOut(); } catch { /* */ }
  });

  const stock = async (): Promise<number> => Number(((await db.from("insumos").select("stock_actual").eq("id", insumoId!).single()).data)!.stock_actual ?? 0);

  test("entrada → merma → conteo ciego revela diferencia y ajusta", async () => {
    if (!motivoId) { test.skip(true, "Sin motivos de merma"); return; }

    // Insumo nuevo a $100/kg, stockeable.
    const { data: ins } = await db.from("insumos").insert([{ nombre: `${SENT} insumo`, unidad: "kg", tenant_id: tenantId, activo: true, stock_disponible: true, costo_actual: 100 }]).select("id").single();
    insumoId = ins!.id as number;

    // Entrada de stock +100 (el trigger actualiza stock_actual).
    await db.from("insumo_movimientos").insert([{ tenant_id: tenantId, local_id: localId, insumo_id: insumoId, tipo: "entrada_ajuste", cantidad: 100, costo_unitario: 100, motivo: "carga inicial test" }]);
    expect(await stock()).toBe(100);

    // Merma de 10 → stock 90.
    const { error: mErr } = await db.rpc("fn_registrar_merma", { p_insumo_id: insumoId, p_local_id: localId, p_cantidad: 10, p_motivo_id: motivoId, p_notas: "test" });
    expect(mErr).toBeNull();
    expect(await stock()).toBe(90);

    // Iniciar conteo ciego → snapshot teórico = 90.
    const { data: cid, error: iErr } = await db.rpc("fn_iniciar_conteo_fisico", { p_local_id: localId, p_notas: "mutante" });
    expect(iErr).toBeNull();
    conteoId = cid as number;
    const { data: lineaTeo } = await db.from("stock_conteo_lineas").select("stock_teorico").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
    expect(Number(lineaTeo!.stock_teorico)).toBe(90);

    // Cargar contado = 85 (faltan 5 — el empleado no ve el teórico).
    const { error: cErr } = await db.rpc("fn_cargar_conteo_linea", { p_conteo_id: conteoId, p_insumo_id: insumoId, p_stock_contado: 85, p_notas: null });
    expect(cErr).toBeNull();

    // Finalizar → diferencia = -5, ajuste aplicado, stock = 85.
    const { error: fErr } = await db.rpc("fn_finalizar_conteo_fisico", { p_conteo_id: conteoId });
    expect(fErr).toBeNull();
    const { data: lineaFin } = await db.from("stock_conteo_lineas").select("diferencia, stock_contado").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
    expect(Number(lineaFin!.stock_contado)).toBe(85);
    expect(Number(lineaFin!.diferencia)).toBe(-5);
    expect(await stock()).toBe(85);
  });
});
