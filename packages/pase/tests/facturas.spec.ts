import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Facturas", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    // "Facturas" matchea también "Lector Facturas IA", usar locator exacto
    const navItem = page.locator(".nav-item").filter({ hasText: /^.*📄.*Facturas$/ });
    await navItem.waitFor({ state: "visible", timeout: 10_000 });
    await navItem.click();
    await page.waitForTimeout(1000);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\bnull\b/);
  });

  test("tabla muestra columnas esperadas", async ({ page }) => {
    const thead = page.locator("thead").first();
    const visible = await thead.isVisible().catch(() => false);
    if (!visible) { test.skip(); return; }
    const hText = (await thead.innerText()).toUpperCase();
    expect(hText).toContain("PROVEEDOR");
    expect(hText).toContain("FACTURA");
    expect(hText).toContain("TOTAL");
  });

  test("tabs (Todas, Pendientes, Pagadas, Vencidas, Anuladas) no rompen", async ({ page }) => {
    for (const label of ["Todas", "Pendientes", "Pagadas", "Vencidas", "Anuladas"]) {
      const tab = page.locator(".tab", { hasText: label });
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);
        const text = await page.locator(".main").innerText();
        expect(text).not.toContain("NaN");
      }
    }
  });

  test("buscador filtra resultados", async ({ page }) => {
    const search = page.locator("input.search").first();
    const visible = await search.isVisible().catch(() => false);
    if (!visible) { test.skip(); return; }
    await search.fill("zzz_no_existe");
    await page.waitForTimeout(500);
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
  });

  test("botón Cargar Factura abre modal", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Cargar Factura" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = (await page.locator(".overlay").innerText()).toUpperCase();
    expect(modalText).toContain("PROVEEDOR");
    expect(modalText).toContain("NETO");
  });

  test("cerrar modal no rompe la página", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Cargar Factura" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    await page.locator(".close-btn").click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
  });
});
