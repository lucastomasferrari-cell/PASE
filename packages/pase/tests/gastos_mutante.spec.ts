import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: carga un gasto desde la UI contra prod (RPC atómica
// crear_gasto), verifica los 3 efectos en DB (gastos + movimientos +
// saldos_caja con resta exacta del sentinel). Cleanup híbrido: anular el
// movimiento (la única RPC que revierte saldo atómicamente) y después
// borrar las dos filas residuales para no dejar el sentinel en la tabla.
const SENTINEL = 234567.89;
const LOCAL = "Local Prueba 2";
const CUENTA = "Caja Efectivo";
const CATEGORIA = "OTROS FIJOS";
const TIPO_ESPERADO = "fijo";
const TIPO_MOV_ESPERADO = "Gasto fijo";

test.describe("Gastos — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let saldoInicial: number;
  let gastoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    // Resolver local_id + tenant_id de "Local Prueba 2".
    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, nombre, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    // Pre-check explícito: la fila (cuenta="Caja Efectivo", local_id) DEBE
    // existir en saldos_caja. crear_gasto no la crea, solo actualiza — sin
    // ella el saldo nunca cambia y el assert final fallaría con un
    // diagnóstico confuso. Mejor frenar acá con un mensaje accionable.
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", CUENTA)
      .eq("local_id", localId)
      .maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA}", local_id=${localId}). ` +
        `Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) ` +
        `VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoInicial = saldoRow.saldo as number;

    gastoId = null;
    movId = null;

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cada paso en su propio try/catch — un fallo en uno no debe abortar
    // los siguientes. Querés que se intente borrar todo lo creado.
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", {
          p_mov_id: movId,
          p_motivo: "e2e mutante cleanup",
        });
        if (error && !error.message.includes("YA_ANULADO")) {
           
          console.error(`[cleanup] anular_movimiento(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] anular_movimiento threw:`, e);
      }
    }
    if (movId) {
      try {
        const { error } = await db.from("movimientos").delete().eq("id", movId);
        if (error) {
           
          console.error(`[cleanup] delete movimientos(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete movimientos threw:`, e);
      }
    }
    if (gastoId) {
      try {
        const { error } = await db.from("gastos").delete().eq("id", gastoId);
        if (error) {
           
          console.error(`[cleanup] delete gastos(${gastoId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete gastos threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("cargar gasto crea gasto + movimiento + resta del saldo", async ({ page }) => {
    await goTo(page, "Gastos");

    await page.getByRole("button", { name: "+ Cargar Gasto" }).click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });

    const modal = page.locator(".overlay .modal");

    // Tipo: queda en default "fijo" (lo que dispara catsByTipo("fijo")).
    // Categoría: "OTROS FIJOS" — neutral, no es un costo recurrente real.
    await modal.locator('.field:has(label:has-text("Categoría")) select')
      .selectOption({ label: CATEGORIA });

    // Local — el dueño ve un select con "Todos" + locales disponibles.
    await modal.locator('.field:has(label:has-text("Local")) select')
      .selectOption({ label: LOCAL });

    // Fecha: default hoy. Sin cambios.

    // Cuenta de egreso (label tiene asterisco — match parcial).
    await modal.locator('.field:has(label:has-text("Cuenta de egreso")) select')
      .selectOption({ label: CUENTA });

    // Monto.
    await modal.locator('.field:has(label:has-text("Monto")) input')
      .fill(String(SENTINEL));

    await modal.getByRole("button", { name: "Guardar" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: el gasto existe en DB con sentinel ─────────────────────
    const { data: gastos, error: gastosErr } = await db
      .from("gastos")
      .select("id, local_id, monto, categoria, tipo, cuenta")
      .eq("local_id", localId)
      .eq("monto", SENTINEL);
    expect(gastosErr).toBeNull();
    expect(gastos?.length).toBe(1);
    expect(gastos?.[0]?.categoria).toBe(CATEGORIA);
    expect(gastos?.[0]?.tipo).toBe(TIPO_ESPERADO);
    expect(gastos?.[0]?.cuenta).toBe(CUENTA);
    gastoId = gastos![0]!.id as string;

    // ── Assert 2: el movimiento asociado existe (importe negativo) ───────
    const { data: movs, error: movsErr } = await db
      .from("movimientos")
      .select("id, cuenta, local_id, importe, tipo, cat, gasto_id_ref")
      .eq("gasto_id_ref", gastoId);
    expect(movsErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.tipo).toBe(TIPO_MOV_ESPERADO);
    expect(movs?.[0]?.cat).toBe(CATEGORIA);
    movId = movs![0]!.id as string;

    // ── Assert 3: el saldo bajó por SENTINEL exacto ──────────────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", CUENTA)
      .eq("local_id", localId)
      .maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoInicial - SENTINEL);
  });
});
