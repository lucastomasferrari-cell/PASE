import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: conciliar un egreso de MP creando un gasto nuevo.
// Setup: insert directo de mp_movimiento sandbox (egreso, sin justificativo).
// Act vía UI: Conciliación MP → click "Conciliar" en la fila → tab Gasto →
// "+ Crear gasto nuevo" → categoría "OTROS FIJOS" → "Crear gasto y conciliar".
// La RPC fn_conciliar_mp_con_gasto inserta gasto + movimiento + actualiza
// saldos_caja MercadoPago + setea justificativo_* en el mp_movimiento.
const SENTINEL = 678901.24;
const LOCAL = "Local Prueba 2";
const CUENTA = "MercadoPago";
const CATEGORIA = "OTROS FIJOS";
const DESCRIPCION = `E2E mutante egreso ${Date.now()}`;
const MP_TIPO = "bank_transfer"; // permitido (la RPC bloquea fee/tax)

function genMpMovId(): string {
  return `mock-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

test.describe("Conciliación MP — egreso mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let saldoMpInicial: number;
  let mpMovId: string | null = null;
  let gastoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    // Resolver local + tenant_id.
    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    // Pre-check saldos_caja (MercadoPago, Local Prueba 2). La RPC
    // _actualizar_saldo_caja actualiza la fila existente, no la crea.
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoMpInicial = saldoRow.saldo as number;

    // Inyectar mp_movimiento sandbox (egreso). Validaciones de la RPC
    // (verified _validar_mp_mov_conciliable): existe + tenant matchea +
    // anulado=false + monto<0 + tipo no en (fee, tax) + justificativo_tipo null.
    mpMovId = genMpMovId();
    const { error: insertErr } = await db.from("mp_movimientos").insert([{
      id: mpMovId,
      local_id: localId,
      tenant_id: tenantId,
      fecha: new Date().toISOString(),
      tipo: MP_TIPO,
      descripcion: DESCRIPCION,
      monto: -SENTINEL,
      estado: "approved",
      conciliado: false,
      anulado: false,
    }]);
    if (insertErr) throw new Error(`Error insertando mp_movimiento sandbox: ${insertErr.message}`);

    gastoId = null;
    movId = null;

    page.on("dialog", d => { d.accept().catch(() => { /* idempotente */ }); });

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // No existe fn_desconciliar_mp. Cleanup manual con cada paso aislado.
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
    if (mpMovId) {
      try {
        const { error } = await db.from("mp_movimientos").delete().eq("id", mpMovId);
        if (error) {
           
          console.error(`[cleanup] delete mp_movimientos(${mpMovId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete mp_movimientos threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("conciliar egreso MP con gasto nuevo: gasto + movimiento + saldo MP + flag justificativo", async ({ page }) => {
    await goTo(page, "Conciliación MP");

    // Encontrar la fila del mp_movimiento sandbox por su descripcion única.
    const fila = page.locator("tr", { hasText: DESCRIPCION });
    await fila.waitFor({ state: "visible", timeout: 15_000 });
    await fila.getByRole("button", { name: "Conciliar" }).click();

    // Modal "Conciliar egreso MP". Tab Gasto está activo por default.
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modal = page.locator(".overlay .modal");
    await expect(modal.locator(".modal-title", { hasText: "Conciliar egreso MP" })).toBeVisible();

    // Select "Gasto a vincular" → "+ Crear gasto nuevo". El value de la
    // primera option es "__NUEVO__".
    await modal.locator('select').filter({
      has: page.locator('option[value="__NUEVO__"]'),
    }).first().selectOption("__NUEVO__");

    // Combobox de Categoría. Aparece después de elegir "+ Crear gasto nuevo".
    // El input filtra por texto; tras escribir "OTROS FIJOS" la opción única
    // queda highlighted y Enter la selecciona.
    const catInput = modal.locator('input[placeholder="Buscar o elegir categoría..."]');
    await catInput.click();
    await catInput.fill(CATEGORIA);
    await catInput.press("Enter");

    // Botón "Crear gasto y conciliar" en el footer.
    await modal.getByRole("button", { name: "Crear gasto y conciliar" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Capturar IDs primero (antes de cualquier assert) ─────────────────
    // Patrón aprendido del test sueldo_pagar: si un assert falla después,
    // el cleanup todavía tiene los IDs para revertir saldo + borrar rows.
    const { data: mpsAfter, error: mpAfterErr } = await db
      .from("mp_movimientos")
      .select("id, justificativo_tipo, justificativo_id, justificativo_at")
      .eq("id", mpMovId);
    if (mpsAfter && mpsAfter.length > 0 && mpsAfter[0]?.justificativo_id) {
      gastoId = mpsAfter[0].justificativo_id as string;
    }

    const { data: movs, error: movErr } = gastoId
      ? await db.from("movimientos")
          .select("id, cuenta, local_id, importe, tipo, cat")
          .eq("cuenta", CUENTA)
          .eq("local_id", localId)
          .eq("importe", -SENTINEL)
          .eq("tipo", "Conciliación MP - Gasto")
      : { data: null, error: null };
    if (movs && movs.length > 0) movId = movs[0]!.id as string;

    // ── Assert 1: mp_movimiento marcado como conciliado ──────────────────
    expect(mpAfterErr).toBeNull();
    expect(mpsAfter?.length).toBe(1);
    expect(mpsAfter?.[0]?.justificativo_tipo).toBe("gasto");
    expect(mpsAfter?.[0]?.justificativo_id).toBeTruthy();
    expect(mpsAfter?.[0]?.justificativo_at).not.toBeNull();

    // ── Assert 2: gasto creado con sentinel en MercadoPago ───────────────
    expect(gastoId).toBeTruthy();
    const { data: gastos, error: gastosErr } = await db
      .from("gastos").select("id, monto, cuenta, categoria, local_id")
      .eq("id", gastoId);
    expect(gastosErr).toBeNull();
    expect(gastos?.length).toBe(1);
    expect(gastos?.[0]?.monto).toBe(SENTINEL);
    expect(gastos?.[0]?.cuenta).toBe(CUENTA);
    expect(gastos?.[0]?.categoria).toBe(CATEGORIA);
    expect(gastos?.[0]?.local_id).toBe(localId);

    // ── Assert 3: movimiento de egreso con importe negativo ──────────────
    expect(movErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.tipo).toBe("Conciliación MP - Gasto");
    expect(movs?.[0]?.cat).toBe(CATEGORIA);

    // ── Assert 4: saldos_caja MercadoPago bajó por SENTINEL ──────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoMpInicial - SENTINEL);
  });
});
