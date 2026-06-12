import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: carga una venta de efectivo desde la UI contra prod y
// verifica los 3 efectos (ventas + movimientos + saldos_caja). Cleanup en
// afterEach con la RPC atómica eliminar_venta. Sentinel raro para que un
// leftover sea trivial de detectar a ojo.
const SENTINEL = 1234567.89;
const LOCAL = "Local Prueba 2";
const MEDIO = "EFECTIVO SALON";

test.describe("Ventas — efectivo mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let cuentaEfectivo: string;
  let saldoInicial: number;
  let ventaId: string | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    // Resolver local_id de "Local Prueba 2" — falla ruidosamente si no existe
    // o si hay duplicados (mejor un test roto que un cleanup contra el local
    // equivocado).
    const { data: locales, error: locErr } = await db
      .from("locales").select("id, nombre").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar antes de correr el test`);
    localId = locales[0].id as number;

    // Resolver cuenta_destino del medio EFECTIVO SALON para este local.
    // Misma regla que pickCuentaDestino: local-specific gana sobre global.
    const { data: medios, error: medErr } = await db
      .from("medios_cobro")
      .select("nombre, local_id, cuenta_destino, activo")
      .eq("nombre", MEDIO)
      .eq("activo", true);
    if (medErr) throw new Error(`Error consultando medios_cobro: ${medErr.message}`);
    const candidatos = (medios || []).filter(m => m.local_id === null || m.local_id === localId);
    const ganador = candidatos.find(m => m.local_id !== null) || candidatos[0];
    if (!ganador?.cuenta_destino) throw new Error(`No hay cuenta_destino para medio "${MEDIO}" en local ${localId}`);
    cuentaEfectivo = ganador.cuenta_destino as string;

    // Snapshot del saldo. Si la fila no existe, asumimos 0 y dejamos que la
    // app la cree (si no la crea, el assert va a fallar con diagnóstico claro).
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", cuentaEfectivo)
      .eq("local_id", localId)
      .maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    saldoInicial = (saldoRow?.saldo as number | undefined) ?? 0;

    ventaId = null;

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    try {
      // Red de seguridad (12-jun): buscar el sentinel SIN filtro de local.
      // Si una corrida rota guardó la venta en un local equivocado (pasó:
      // cayó en Neko Villa Crespo, un local REAL), igual la levantamos acá.
      const { data: huerfanas } = await db
        .from("ventas")
        .select("id, local_id")
        .eq("monto", SENTINEL);
      const ids = new Set<string>((huerfanas ?? []).map(v => v.id as string));
      if (ventaId) ids.add(ventaId);
      for (const id of ids) {
        const { error } = await db.rpc("eliminar_venta", { p_venta_id: id });
        if (error) {
          // No throw: ya estamos en afterEach. Log para diagnosticar manualmente.
          console.error(`[cleanup] eliminar_venta(${id}) falló: ${error.message}`);
        }
      }
    } finally {
      await db.auth.signOut().catch(() => { /* idempotente */ });
    }
  });

  test("cargar venta efectivo crea venta + movimiento + suma al saldo", async ({ page }) => {
    await goTo(page, "Ventas");

    await page.getByRole("button", { name: "+ Cargar venta" }).click();

    // Modal nuevo (refactor c43ea74): <Modal> con role="dialog" + aria-label=title.
    const modal = page.getByRole("dialog", { name: "Nueva Venta" });
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // ── BARRERA DE SEGURIDAD (12-jun) ────────────────────────────────────
    // El campo Local ya no es un select del modal: con sucursal activa en el
    // sidebar muestra un LocalLockedChip con el nombre. Si el chip NO dice
    // "Local Prueba 2", el sentinel iría a parar a un local REAL (pasó con
    // Neko Villa Crespo) → frenamos ANTES de guardar.
    await expect(
      modal.getByText(LOCAL, { exact: false }),
      `El modal debe estar bloqueado en "${LOCAL}" (chip del sidebar). Si muestra otro local, loginAs no seteó la sucursal.`,
    ).toBeVisible({ timeout: 5_000 });

    // Default fecha = hoy y turno = Noche, no los tocamos.

    // Primera fila de forma de cobro: select.search (medio) + input[type=number] (monto).
    await modal.locator("select.search").first().selectOption({ label: MEDIO });
    await modal.locator('input[type="number"]').first().fill(String(SENTINEL));

    await modal.getByRole("button", { name: "Guardar" }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: la venta existe en DB con sentinel exacto Y EN EL LOCAL
    // CORRECTO. Buscamos SIN filtro de local a propósito: si cayó en otro
    // local (el accidente del 12-jun), este assert lo grita acá mismo.
    const { data: ventas, error: ventasErr } = await db
      .from("ventas")
      .select("id, local_id, monto, medio, turno")
      .eq("monto", SENTINEL);
    expect(ventasErr).toBeNull();
    expect(ventas?.length).toBe(1);
    ventaId = ventas![0]!.id as string;
    expect(
      ventas?.[0]?.local_id,
      `La venta sentinel cayó en local_id=${ventas?.[0]?.local_id} en vez de ${localId} (${LOCAL}) — revisar loginAs/sidebar`,
    ).toBe(localId);
    expect(ventas?.[0]?.medio).toBe(MEDIO);
    expect(ventas?.[0]?.turno).toBe("Noche");

    // ── Assert 2: el movimiento asociado existe ─────────────────────────
    const { data: movs, error: movsErr } = await db
      .from("movimientos")
      .select("id, cuenta, local_id, importe, tipo, cat, venta_ids")
      .eq("local_id", localId)
      .eq("cuenta", cuentaEfectivo)
      .eq("importe", SENTINEL)
      .contains("venta_ids", [ventaId]);
    expect(movsErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.tipo).toBe("Ingreso Venta");
    expect(movs?.[0]?.cat).toBe("VENTAS");

    // ── Assert 3: el saldo subió por SENTINEL exacto ────────────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", cuentaEfectivo)
      .eq("local_id", localId)
      .maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoInicial + SENTINEL);
  });
});
