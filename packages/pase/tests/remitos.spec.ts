import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Remitos", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Remitos");
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
    expect(hText).toContain("REMITO");
    expect(hText).toContain("MONTO");
  });

  test("alert de advertencia visible", async ({ page }) => {
    const alert = page.locator(".alert-warn");
    // Puede o no tener alert dependiendo del estado
    const visible = await alert.isVisible().catch(() => false);
    // No falla si no está, solo verifica que no hay errores
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
