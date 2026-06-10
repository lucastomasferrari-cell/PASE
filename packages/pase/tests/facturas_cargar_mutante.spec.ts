import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: carga una factura manual (sin lector IA) desde la UI contra
// prod. Verifica los efectos en facturas + proveedores.saldo (recalculado
// por trigger trg_saldo_proveedor — migration 202605070900). Cleanup
// híbrido: anular_factura + delete del row.
const SENTINEL = 345678.91;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const NRO = `E2E-FACT-${Date.now()}`;

test.describe("Facturas — cargar mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let provId: number;
  let saldoProvInicial: number;
  let facturaId: string | null = null;

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

    // Pre-check: el proveedor "Proveedor Prueba" debe existir en el tenant.
    // Si no, mensaje accionable con el INSERT listo para copiar.
    const { data: provs, error: provErr } = await db
      .from("proveedores")
      .select("id, nombre, saldo, estado, tenant_id")
      .eq("nombre", PROVEEDOR);
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

    facturaId = null;

    // Defensa contra el confirm() de duplicados (Compras.tsx:296) y
    // cualquier alert() de validación que aparezca: aceptar siempre.
    page.on("dialog", d => { d.accept().catch(() => { /* idempotente */ }); });

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cada paso aislado: si uno falla, los siguientes igual se intentan.
    if (facturaId) {
      try {
        const { error } = await db.rpc("anular_factura", {
          p_factura_id: facturaId,
          p_motivo: "e2e mutante cleanup",
        });
        if (error && !error.message.includes("YA_ANULADA")) {
           
          console.error(`[cleanup] anular_factura(${facturaId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] anular_factura threw:`, e);
      }
    }
    if (facturaId) {
      try {
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

  test("cargar factura manual crea factura + recalcula saldo proveedor", async ({ page }) => {
    await goTo(page, "Compras");

    await page.getByRole("button", { name: "+ Cargar factura" }).click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });

    const modal = page.locator(".overlay .modal");

    // Tipo de comprobante: queda en "Factura" (default).
    // Local: "Local Prueba 2"
    await modal.locator('.field:has(label:has-text("Local")) select')
      .selectOption({ label: LOCAL });

    // Proveedor: "Proveedor Prueba"
    await modal.locator('.field:has(label:has-text("Proveedor")) select')
      .selectOption({ label: PROVEEDOR });

    // Nº de factura: único por timestamp para no chocar con el detector de
    // duplicados (que igual está cubierto por el dialog auto-accept).
    await modal.locator('.field:has(label:has-text("Nº Factura")) input').fill(NRO);

    // Categoría EERR: skip (queda vacía → bucket null → tratado como CMV).
    // Fecha: default hoy. Vencimiento: skip.

    // Neto Gravado: CurrencyInput acumula dígitos vía keydown. Foco + type
    // de cada dígito → cents = 34567891 → 345678.91 pesos.
    const netoInput = modal.locator('input[aria-label="Neto gravado"]');
    await netoInput.click();
    await page.keyboard.type("34567891", { delay: 10 });

    // IVAs y demás quedan en 0 → total = neto = SENTINEL.

    await modal.getByRole("button", { name: "Guardar" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: la factura existe en DB con sentinel ───────────────────
    const { data: facturas, error: facturasErr } = await db
      .from("facturas")
      .select("id, prov_id, local_id, nro, total, neto, estado, tipo, pagos")
      .eq("nro", NRO);
    expect(facturasErr).toBeNull();
    expect(facturas?.length).toBe(1);
    const f = facturas![0]!;
    expect(f.total).toBe(SENTINEL);
    expect(f.neto).toBe(SENTINEL);
    expect(f.prov_id).toBe(provId);
    expect(f.local_id).toBe(localId);
    expect(f.estado).toBe("pendiente");
    expect(f.tipo).toBe("factura");
    facturaId = f.id as string;

    // ── Assert 2: factura_items vacío (no agregamos items) ───────────────
    const { data: items, error: itemsErr } = await db
      .from("factura_items")
      .select("id")
      .eq("factura_id", facturaId);
    expect(itemsErr).toBeNull();
    expect(items?.length).toBe(0);

    // ── Assert 3: saldo del proveedor subió por SENTINEL exacto ──────────
    // El trigger trg_saldo_proveedor recalcula al INSERT en facturas.
    const { data: provFinal, error: provFinalErr } = await db
      .from("proveedores")
      .select("saldo")
      .eq("id", provId)
      .maybeSingle();
    expect(provFinalErr).toBeNull();
    expect(provFinal?.saldo).toBe(saldoProvInicial + SENTINEL);
  });
});
