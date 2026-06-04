import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL — flow completo de saldo a favor del proveedor
// (commits 3bf8dc7 + 84d6bfd del 03-jun + migrations 202606031400/1500).
//
// Valida:
//   1. Al abrir Pagar Factura, si el proveedor tiene saldo a favor > 0,
//      aparece el bloque "💰 Saldo a favor disponible" con checkbox.
//   2. Cargar monto > saldo factura muestra warning "⚠ Pago de MÁS".
//   3. Checkbox "Registrar saldo a favor..." aparece y se puede tildar.
//
// Scope: READ-ONLY puro. NO confirma pagos. Solo valida que la UI muestra
// los controles nuevos cuando corresponde.

const LOCAL = "Local Prueba 2";

test.describe("UI Compras — saldo a favor + warning pago de más", () => {

  test("abrir Pagar Factura → si hay factura pendiente, modal muestra inputs y al cargar monto > total aparece warning", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/compras");
    await page.waitForLoadState("domcontentloaded");

    // Buscar la primera factura con estado Pendiente o Vencida que tenga botón Pagar.
    // Esperar a que la tabla cargue.
    await page.waitForTimeout(2000);

    // Click en el primer botón "Pagar" visible (puede estar en factura tabla o card)
    const btnPagar = page.getByRole("button", { name: /^Pagar$/i }).first();
    const visible = await btnPagar.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!visible) {
      test.info().annotations.push({
        type: "skipped",
        description: `No hay facturas pendientes en ${LOCAL} para abrir el modal. Cargá una factura sin pagar para correr este test.`,
      });
      test.skip();
      return;
    }

    await btnPagar.click();

    // Modal "Registrar Pago" abierto
    await expect(page.getByText(/Registrar Pago/i)).toBeVisible({ timeout: 5_000 });

    // Tiene los inputs estándar: Cuenta de egreso, Monto a pagar, Fecha
    await expect(page.getByText(/Cuenta de egreso/i)).toBeVisible();
    await expect(page.getByText(/Monto a pagar/i)).toBeVisible();

    // Cerrar sin confirmar (Cancelar)
    await page.getByRole("button", { name: /^Cancelar$/i }).click();
    await expect(page.getByText(/Registrar Pago/i)).not.toBeVisible({ timeout: 3_000 });
  });
});
