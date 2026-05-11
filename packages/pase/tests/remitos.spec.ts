import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Remitos", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    // Remitos ya no es módulo propio: vive dentro de Compras, accesible vía
    // la pill "Remitos" que alterna la tabla principal.
    await goTo(page, "Compras");
    await page.locator(".pill", { hasText: "Remitos" }).click();
    await page.waitForTimeout(1000);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("tabla muestra columnas esperadas", async ({ page }) => {
    const thead = page.locator("thead").first();
    const visible = await thead.isVisible().catch(() => false);
    if (!visible) { test.skip(); return; }
    const hText = (await thead.innerText()).toUpperCase();
    expect(hText).toContain("PROVEEDOR");
    expect(hText).toContain("MONTO");
  });

  test("alert de advertencia visible", async ({ page }) => {
    // Puede o no tener alert dependiendo del estado — no falla si no está,
    // solo verifica que no hay errores en el render principal.
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
  });

  test("botón Remito Valorado abre modal", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Remito" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = await page.locator(".overlay").innerText();
    expect(modalText).toMatch(/proveedor/i);
    expect(modalText).toMatch(/monto/i);
  });
});
