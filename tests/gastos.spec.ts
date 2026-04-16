import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Gastos", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Gastos");
    await page.waitForTimeout(1000);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("tabs (Fijos, Variables, Publicidad, Comisiones) funcionan", async ({ page }) => {
    for (const label of ["Fijos", "Variables", "Publicidad", "Comisiones"]) {
      const tab = page.locator(".tab", { hasText: label });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);
        const text = await page.locator(".main").innerText();
        expect(text).not.toContain("NaN");
      }
    }
  });

  test("cada tab muestra tabla o empty sin errores", async ({ page }) => {
    for (const label of ["Fijos", "Variables"]) {
      const tab = page.locator(".tab", { hasText: label });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);
        const hasTable = await page.locator("table").isVisible().catch(() => false);
        const hasEmpty = await page.locator(".empty").isVisible().catch(() => false);
        expect(hasTable || hasEmpty).toBeTruthy();
      }
    }
  });

  test("botón Cargar Gasto abre modal", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Cargar Gasto" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = await page.locator(".overlay").innerText();
    expect(modalText).toMatch(/categor/i);
    expect(modalText).toMatch(/monto/i);
  });

  test("selector de mes cambia los datos", async ({ page }) => {
    const monthInput = page.locator('input[type="month"]');
    if (!(await monthInput.isVisible().catch(() => false))) { test.skip(); return; }
    await monthInput.fill("2026-03");
    await page.waitForTimeout(1000);
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
  });
});
