import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: pagar una factura ya cargada. Atajo el setup insertando la
// factura directamente vía DB (más rápido que cargar via UI), y verifico
// los 4 efectos de la RPC pagar_factura: estado "pagada" + pagos[] +
// movimiento de egreso + saldo de caja - SENTINEL + saldo proveedor de
// vuelta a su inicial (la factura pagada queda excluida del recálculo).
const SENTINEL = 456789.12;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const CUENTA = "Caja Efectivo";

function genFacturaId(): string {
  // Mismo patrón que utils.ts::genId para que el id sea indistinguible de
  // uno generado por la app.
  return `FACT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe("Facturas — pagar mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let provId: number;
  let saldoProvInicial: number;
  let saldoCajaInicial: number;
  let facturaId: string | null = null;
  let nro: string;
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

    // Pre-check proveedor — fail loud con INSERT.
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
    // Snapshot ANTES del INSERT — al pagar, el trigger excluye la factura
    // y el saldo del proveedor vuelve exactamente a este valor.
    saldoProvInicial = (provs[0].saldo as number | null) ?? 0;

    // Pre-check saldos_caja — fail loud con INSERT.
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) ` +
        `VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoCajaInicial = saldoRow.saldo as number;

    // Generar id + nro únicos. nro con timestamp evita el detector de
    // duplicados de Compras.tsx (que igual no se dispara porque el insert
    // bypassa la UI, pero sirve para ubicar la fila al hacer click).
    facturaId = genFacturaId();
    nro = `E2E-PAGAR-${Date.now()}`;
    movId = null;

    // INSERT factura "pendiente" directamente. El trigger trg_saldo_proveedor
    // dispara al INSERT y sube provider.saldo por SENTINEL — eso es lo
    // esperado y se compensa después al pagar.
    const { error: insertErr } = await db.from("facturas").insert([{
      id: facturaId,
      prov_id: provId,
      local_id: localId,
      nro,
      fecha: todayISO(),
      total: SENTINEL,
      neto: SENTINEL,
      iva21: 0,
      iva105: 0,
      iibb: 0,
      perc_iva: 0,
      otros_cargos: 0,
      descuentos: 0,
      estado: "pendiente",
      pagos: [],
      tipo: "factura",
      tenant_id: tenantId,
    }]);
    if (insertErr) throw new Error(`Error insertando factura setup: ${insertErr.message}`);

    page.on("dialog", d => { d.accept().catch(() => { /* idempotente */ }); });

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cada paso aislado en su propio try/catch.
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
    if (facturaId) {
      try {
        // delete fact dispara el trigger pero como ya estaba en estado
        // "pagada" (excluida del cálculo), borrarla no cambia provider.saldo.
        const { error } = await db.from("facturas").delete().eq("id", facturaId);
        if (error) {
           
          console.error(`[cleanup] delete facturas(${facturaId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete facturas threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("pagar factura pendiente: estado, pagos[], movimiento, saldo caja y saldo proveedor", async ({ page }) => {
    await goTo(page, "Compras");

    // Encontrar la fila de la factura insertada y click "Pagar".
    const fila = page.locator("tr", { hasText: nro });
    await fila.waitFor({ state: "visible", timeout: 10_000 });
    await fila.getByRole("button", { name: "Pagar" }).click();

    // Modal "Registrar Pago".
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modal = page.locator(".overlay .modal");

    // Cuenta = "Caja Efectivo". Monto default = total factura = SENTINEL.
    // Fecha default = hoy. No tocamos esos campos.
    await modal.locator('.field:has(label:has-text("Cuenta de egreso")) select')
      .selectOption({ label: CUENTA });

    await modal.getByRole("button", { name: "Confirmar Pago" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: factura → "pagada" con pago registrado en JSONB ───────
    const { data: facturas, error: facErr } = await db
      .from("facturas").select("id, estado, pagos, total")
      .eq("id", facturaId);
    expect(facErr).toBeNull();
    expect(facturas?.length).toBe(1);
    expect(facturas?.[0]?.estado).toBe("pagada");
    const pagos = (facturas?.[0]?.pagos || []) as Array<{ cuenta: string; monto: number; fecha: string }>;
    expect(pagos.length).toBe(1);
    expect(pagos[0]?.monto).toBe(SENTINEL);
    expect(pagos[0]?.cuenta).toBe(CUENTA);
    expect(pagos[0]?.fecha).toBe(todayISO());

    // ── Assert 2: movimiento de pago con importe negativo y fact_id link
    const { data: movs, error: movErr } = await db
      .from("movimientos")
      .select("id, cuenta, local_id, importe, tipo, fact_id")
      .eq("fact_id", facturaId);
    expect(movErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.tipo).toBe("Pago Proveedor");
    movId = movs![0]!.id as string;

    // ── Assert 3: saldos_caja bajó por SENTINEL exacto ───────────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoCajaInicial - SENTINEL);

    // ── Assert 4: proveedores.saldo volvió al inicial ───────────────────
    // El INSERT lo había subido por SENTINEL; el UPDATE pagada lo recalcula
    // al excluir la factura → vuelve a saldoProvInicial.
    const { data: provFinal, error: provFinalErr } = await db
      .from("proveedores").select("saldo").eq("id", provId).maybeSingle();
    expect(provFinalErr).toBeNull();
    expect(provFinal?.saldo).toBe(saldoProvInicial);
  });

  // ── Test mutante #2: idempotency (anti doble-click). DB-only. ──────────
  // F8 del plan sunny-creek: la RPC acepta p_idempotency_key. Si se llama
  // 2da vez con el mismo key + mismo fact_id, devuelve el resultado de la
  // 1ra llamada sin duplicar pago/movimiento/saldo.
  test("pagar_factura con idempotency_key: 2da llamada no duplica efectos", async () => {
    const idempKey = `test-fac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { data: r1, error: e1 } = await db.rpc("pagar_factura", {
      p_factura_id: facturaId,
      p_monto: SENTINEL,
      p_cuenta: CUENTA,
      p_fecha: todayISO(),
      p_idempotency_key: idempKey,
    });
    expect(e1).toBeNull();
    const movIdPrimero = (r1 as { mov_id: string }).mov_id;
    movId = movIdPrimero;

    // 2da llamada con misma key.
    const { data: r2, error: e2 } = await db.rpc("pagar_factura", {
      p_factura_id: facturaId,
      p_monto: SENTINEL,
      p_cuenta: CUENTA,
      p_fecha: todayISO(),
      p_idempotency_key: idempKey,
    });
    expect(e2).toBeNull();
    expect((r2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    expect((r2 as { mov_id: string }).mov_id).toBe(movIdPrimero);

    // No se duplicó el movimiento (solo 1 fila con fact_id = facturaId).
    const { data: movsAfter } = await db
      .from("movimientos").select("id").eq("fact_id", facturaId);
    expect(movsAfter?.length).toBe(1);

    // facturas.pagos tiene solo 1 entry (no duplicado).
    const { data: facsAfter } = await db
      .from("facturas").select("estado, pagos").eq("id", facturaId);
    expect(facsAfter?.[0]?.estado).toBe("pagada");
    expect((facsAfter?.[0]?.pagos as unknown[] || []).length).toBe(1);

    // saldos_caja bajó por SENTINEL exacto (no 2x).
    const { data: saldoAfter } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoAfter?.saldo).toBe(saldoCajaInicial - SENTINEL);
  });
});
