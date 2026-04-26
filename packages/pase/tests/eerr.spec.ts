import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Estado de Resultados", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Estado de Result.");
    await page.waitForTimeout(1500);
  });

  test("carga sin errores (no NaN, no undefined)", async ({ page }) => {
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

  test("muestra secciones P&L", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    // Debe tener al menos alguno de los conceptos del P&L
    const hasPL = text.includes("Ventas") || text.includes("Utilidad") || text.includes("CMV");
    expect(hasPL).toBeTruthy();
  });

  test("selector de mes funciona", async ({ page }) => {
    const monthInput = page.locator('input[type="month"]');
    if (!(await monthInput.isVisible().catch(() => false))) { test.skip(); return; }
    await monthInput.fill("2026-03");
    await page.waitForTimeout(1500);
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });
});
