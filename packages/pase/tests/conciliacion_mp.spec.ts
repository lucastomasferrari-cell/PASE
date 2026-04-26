import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Conciliación MP", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Conciliación MP");
    await page.waitForTimeout(1500);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("KPIs visibles con formato $", async ({ page }) => {
    const kpis = page.locator(".kpi");
    const count = await kpis.count();
    expect(count).toBeGreaterThan(0);
    const text = await page.locator(".main").innerText();
    expect(text).toMatch(/\$\s*[\d.,]+/);
  });

  test("tabs (Movimientos, Comisiones MP) funcionan", async ({ page }) => {
    for (const label of ["Movimientos", "Comisiones"]) {
      const tab = page.locator(".tab", { hasText: label });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);
        const text = await page.locator(".main").innerText();
        expect(text).not.toContain("NaN");
      }
    }
  });

  test("botón Sincronizar visible", async ({ page }) => {
    const btn = page.locator("button", { hasText: /sincronizar/i });
    const visible = await btn.isVisible().catch(() => false);
    expect(visible).toBeTruthy();
  });

  test("tabla de movimientos o mensaje vacío sin errores", async ({ page }) => {
    const hasTable = await page.locator("table").isVisible().catch(() => false);
    const hasEmpty = await page.locator(".empty").isVisible().catch(() => false);
    const hasAlert = await page.locator(".alert").isVisible().catch(() => false);
    expect(hasTable || hasEmpty || hasAlert).toBeTruthy();
  });
});
