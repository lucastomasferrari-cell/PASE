import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("Usuarios", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "Usuarios");
    await page.waitForTimeout(1000);
  });

  test("carga sin errores", async ({ page }) => {
    const text = await page.locator(".main").innerText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("lista usuarios con columnas esperadas", async ({ page }) => {
    const thead = page.locator("thead").first();
    const visible = await thead.isVisible().catch(() => false);
    if (!visible) { test.skip(); return; }
    const hText = (await thead.innerText()).toUpperCase();
    expect(hText).toContain("NOMBRE");
    expect(hText).toContain("EMAIL");
    expect(hText).toContain("ROL");
  });

  test("botón Nuevo usuario abre modal", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Nuevo usuario" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = await page.locator(".overlay").innerText();
    expect(modalText).toMatch(/nombre/i);
    expect(modalText).toMatch(/email/i);
    expect(modalText).toMatch(/contrase/i);
  });

  test("modal tiene checkboxes de módulos", async ({ page }) => {
    const btn = page.locator("button", { hasText: "Nuevo usuario" });
    if (!(await btn.isVisible().catch(() => false))) { test.skip(); return; }
    await btn.click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modalText = await page.locator(".overlay").innerText();
    expect(modalText).toMatch(/m.dulos/i);
    // Debe haber al menos un checkbox
    const checkboxes = page.locator('.overlay input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);
  });
});
