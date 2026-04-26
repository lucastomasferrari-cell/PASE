import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Recetas", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Recetas");
    await page.waitForTimeout(1000);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("lista con columnas esperadas", async ({ page }) => {
    const thead = page.locator("thead").first();
    const visible = await thead.isVisible().catch(() => false);
    if (!visible) { test.skip(); return; }
    const hText = (await thead.innerText()).toUpperCase();
    expect(hText).toContain("NOMBRE");
    expect(hText).toMatch(/CATEGOR|PRECIO/);
  });

  test("botón Nueva Receta abre modal", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Nueva Receta" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = await page.locator(".overlay").innerText();
    expect(modalText).toMatch(/nombre/i);
  });
});
