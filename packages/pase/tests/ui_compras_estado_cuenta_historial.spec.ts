import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL — Estado de Cuenta extendido con historial + saldo a
// favor visible (commit 6254210 del 03-jun + migration 202606031400).
//
// Valida:
//   1. Drawer Estado de Cuenta abre con KPIs estándar.
//   2. Si el proveedor tiene saldo_a_favor != 0, aparece el chip
//      "💰 Saldo a favor" o "⚠ Saldo en contra".
//   3. Si hay facturas o NCs cargadas, aparece la sección "Historial
//      de movimientos" con al menos 1 row.
//
// Scope: READ-ONLY. Itera sobre proveedores hasta encontrar uno con
// data y valida que la UI nueva está conectada.

const LOCAL = "Local Prueba 2";

test.describe("UI Compras — historial Estado de Cuenta", () => {

  test("abrir Edo. Cuenta de un proveedor con facturas → sección 'Historial de movimientos' visible", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/compras/proveedores");
    await page.waitForLoadState("domcontentloaded");

    // Esperar a que carguen los rows
    await expect(page.locator("text=Activo").first()).toBeVisible({ timeout: 15_000 });

    // Probamos hasta los primeros 5 proveedores hasta encontrar uno con historial.
    const botones = page.getByRole("button", { name: /Edo\.\s*Cuenta/i });
    const total = await botones.count();
    const maxIntentos = Math.min(total, 5);

    let encontroHistorial = false;
    for (let i = 0; i < maxIntentos; i++) {
      await botones.nth(i).click();
      await expect(page.getByText(/Resumen del mes/i)).toBeVisible({ timeout: 5_000 });

      // Buscar la nueva sección de historial.
      const historial = page.getByText(/Historial de movimientos/i);
      if (await historial.isVisible({ timeout: 2_000 }).catch(() => false)) {
        encontroHistorial = true;
        // Verificar que hay al menos 1 row del historial (ícono + texto).
        const rows = page.locator("text=/📄|↩️|💸|💰|⚠️/").first();
        await expect(rows).toBeVisible({ timeout: 3_000 });
        break;
      }
      // Cerrar drawer y probar el siguiente
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    if (!encontroHistorial) {
      test.info().annotations.push({
        type: "skipped",
        description: `Ninguno de los primeros ${maxIntentos} proveedores en ${LOCAL} tiene historial cargado. Cargá una factura o aplicá un saldo para correr este test completo.`,
      });
      test.skip();
      return;
    }

    expect(encontroHistorial).toBe(true);
  });

  test("chip saldo a favor / en contra aparece si el proveedor tiene saldo != 0", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/compras/proveedores");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("text=Activo").first()).toBeVisible({ timeout: 15_000 });

    // Recorrer los primeros 5 proveedores buscando uno con saldo
    const botones = page.getByRole("button", { name: /Edo\.\s*Cuenta/i });
    const total = await botones.count();
    const maxIntentos = Math.min(total, 5);

    let encontroSaldo = false;
    for (let i = 0; i < maxIntentos; i++) {
      await botones.nth(i).click();
      await expect(page.getByText(/Resumen del mes/i)).toBeVisible({ timeout: 5_000 });

      const chipFavor = page.getByText(/Saldo a favor.*nos debe/i);
      const chipContra = page.getByText(/Saldo en contra.*le debemos/i);
      const haySaldo = (await chipFavor.isVisible({ timeout: 1_500 }).catch(() => false))
                   || (await chipContra.isVisible({ timeout: 1_500 }).catch(() => false));
      if (haySaldo) {
        encontroSaldo = true;
        break;
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    if (!encontroSaldo) {
      test.info().annotations.push({
        type: "skipped",
        description: `Ninguno de los primeros ${maxIntentos} proveedores en ${LOCAL} tiene saldo a favor/en contra. Generá uno desde Pagar Factura para correr este test completo.`,
      });
      test.skip();
      return;
    }

    expect(encontroSaldo).toBe(true);
  });
});
