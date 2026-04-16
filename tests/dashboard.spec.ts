import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
  });

  test("carga sin errores — no muestra undefined, NaN ni null", async ({ page }) => {
    // Esperar a que cargue el contenido
    await page.waitForSelector(".main", { timeout: 10_000 });
    const mainText = await page.locator(".main").innerText();
    expect(mainText).not.toContain("undefined");
    expect(mainText).not.toContain("NaN");
    // "null" como texto suelto, no como parte de otra palabra
    expect(mainText).not.toMatch(/\bnull\b/);
  });

  test("métricas muestran números con formato $, no texto roto", async ({ page }) => {
    await page.waitForSelector(".kpi", { timeout: 10_000 });
    const kpis = page.locator(".kpi");
    const count = await kpis.count();
    expect(count).toBeGreaterThan(0);

    // Al menos un KPI debe tener un valor numérico con formato monetario argentino ($)
    const allText = await page.locator(".main").innerText();
    // Verificar que hay al menos un valor con formato $ (ej: $600.000 o $ 600.000)
    expect(allText).toMatch(/\$\s*[\d.,]+/);
  });

  test.skip("como encargado: solo ve datos de su local", async ({ page }) => {
    // TODO: necesita credenciales de encargado
  });
});
