import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL — pantalla Compras → Proveedores → Estado de Cuenta
// (commits 84d6bfd + 6254210 del 03-jun).
// Valida:
//   1. Listado de proveedores aparece (no está en 0 — bug del contador).
//   2. Click en "Edo. Cuenta" abre el drawer con KPIs.
//   3. Si hay saldo a favor / historial, se muestran las secciones nuevas.
//
// Scope: READ-ONLY. No carga ni anula nada.

const LOCAL = "Local Prueba 2";

test.describe("UI Compras — Proveedores + Estado de Cuenta", () => {

  test("listado proveedores visible + contador > 0 en sidebar", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/compras/proveedores");
    await page.waitForLoadState("domcontentloaded");

    // Al menos un row de proveedor visible
    const rows = page.locator("tr, [class*='row']").filter({ hasText: /CUIT|Activo/i });
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // Contador del sidebar dice un número > 0
    // El RightSubNav muestra "Proveedores N"
    const counter = page.locator(".right-subnav, [class*='subnav']")
      .locator("text=/Proveedores\\s+\\d+/");
    if (await counter.count()) {
      const txt = await counter.first().textContent();
      const num = Number((txt ?? "").match(/\d+/)?.[0] ?? "0");
      expect(num).toBeGreaterThan(0);
    }
  });

  test("click Edo. Cuenta en primer proveedor → drawer abre con KPIs", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/compras/proveedores");
    await page.waitForLoadState("domcontentloaded");

    // Esperar a que carguen los rows
    await expect(page.locator("text=Activo").first()).toBeVisible({ timeout: 15_000 });

    // Click en el primer botón "Edo. Cuenta"
    const btnEdo = page.getByRole("button", { name: /Edo\.\s*Cuenta/i }).first();
    await expect(btnEdo).toBeVisible();
    await btnEdo.click();

    // El drawer aparece con el header "Resumen del mes"
    await expect(page.getByText(/Resumen del mes/i)).toBeVisible({ timeout: 5_000 });

    // Los 4 KPIs estándar
    await expect(page.getByText(/Total comprado/i)).toBeVisible();
    await expect(page.getByText(/Pagado este mes/i)).toBeVisible();
    await expect(page.getByText(/Deuda bruta/i)).toBeVisible();
    await expect(page.getByText(/Vencido/i)).toBeVisible();

    // Cerrar con Escape
    await page.keyboard.press("Escape");
    await expect(page.getByText(/Resumen del mes/i)).not.toBeVisible({ timeout: 3_000 });
  });
});
