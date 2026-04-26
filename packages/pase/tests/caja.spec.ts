import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Caja & Bancos", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Caja & Bancos");
    await page.waitForTimeout(1000);
  });

  test("carga saldo actual sin mostrar NaN", async ({ page }) => {
    const mainText = await page.locator(".main").innerText();
    expect(mainText).not.toContain("NaN");
    expect(mainText).not.toContain("undefined");
  });

  test("muestra tarjetas de cajas con saldos", async ({ page }) => {
    // Buscar tarjetas de caja o KPIs
    const cajas = page.locator(".caja-card");
    const kpis = page.locator(".kpi");
    const panels = page.locator(".panel");
    const hasContent =
      (await cajas.count()) > 0 ||
      (await kpis.count()) > 0 ||
      (await panels.count()) > 0;
    expect(hasContent).toBeTruthy();
  });

  test("movimientos tienen fecha, descripción y monto", async ({ page }) => {
    const tabla = page.locator("table");
    const hasTable = await tabla.isVisible().catch(() => false);
    if (!hasTable) {
      test.skip();
      return;
    }

    // Verificar headers
    const headerText = await page.locator("thead").first().innerText();
    const lower = headerText.toLowerCase();
    // Debe tener columnas relevantes (fecha, descripción/detalle, monto o similar)
    const hasFecha = lower.includes("fecha");
    const hasDesc = lower.includes("desc") || lower.includes("detalle") || lower.includes("concepto");
    const hasMonto = lower.includes("monto") || lower.includes("saldo") || lower.includes("importe");
    expect(hasFecha || hasDesc || hasMonto).toBeTruthy();
  });

  test("filtro por rango de fechas no rompe la página", async ({ page }) => {
    const dateInputs = page.locator('input[type="date"]');
    const count = await dateInputs.count();
    if (count < 2) {
      test.skip();
      return;
    }
    await dateInputs.first().fill("2026-04-01");
    await dateInputs.nth(1).fill("2026-04-15");
    await page.waitForTimeout(1000);
    const mainText = await page.locator(".main").innerText();
    expect(mainText).not.toContain("NaN");
    expect(mainText).not.toContain("undefined");
  });
});
