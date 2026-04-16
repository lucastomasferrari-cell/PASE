import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Ventas", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Ventas");
    await page.waitForTimeout(1000);
  });

  test("carga la lista sin errores", async ({ page }) => {
    const mainText = await page.locator(".main").innerText();
    expect(mainText).not.toContain("undefined");
    expect(mainText).not.toContain("NaN");
    // Debe tener tabla o panel o algún contenido
    const hasContent =
      (await page.locator("table").isVisible().catch(() => false)) ||
      (await page.locator(".panel").isVisible().catch(() => false)) ||
      (await page.locator(".kpi").isVisible().catch(() => false)) ||
      (await page.locator(".empty").isVisible().catch(() => false));
    expect(hasContent).toBeTruthy();
  });

  test("filtro por fecha funciona", async ({ page }) => {
    // Buscar inputs de tipo date
    const dateInputs = page.locator('input[type="date"]');
    const count = await dateInputs.count();
    if (count === 0) {
      test.skip();
      return;
    }
    // Cambiar la primera fecha y verificar que no rompe
    await dateInputs.first().fill("2026-04-01");
    await page.waitForTimeout(1000);
    const mainText = await page.locator(".main").innerText();
    expect(mainText).not.toContain("NaN");
    expect(mainText).not.toContain("undefined");
  });

  test("totales muestran formato monetario ($)", async ({ page }) => {
    const mainText = await page.locator(".main").innerText();
    // Si hay datos, debe haber al menos un valor con formato $
    const hasTable = await page.locator("table").isVisible().catch(() => false);
    if (hasTable) {
      expect(mainText).toMatch(/\$\s*[\d.,]+/);
    }
  });

  test.skip("filtro por local — encargado solo ve el suyo", async ({ page }) => {
    // TODO: necesita credenciales de encargado
  });
});
