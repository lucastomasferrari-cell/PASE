import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL — flow del checkbox "Mantener sesión abierta"
// (commits 27fe599, 53d8eaf, 6c5c377 de 02-03-jun).
// Valida:
//   1. El checkbox aparece en el login y está tildado por default.
//   2. Persiste el flag en localStorage al cambiarlo.
//   3. F5 después de login mantiene la sesión.
//
// NO simula deploy ni token refresh (más complejo, queda para otra ronda).

test.describe("UI Login — checkbox 'Mantener sesión abierta'", () => {

  test("checkbox visible en Login, default tildado", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".login-card", { timeout: 15_000 });

    const checkbox = page.locator('input[type="checkbox"]').first();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();

    // Label asociado
    await expect(page.getByText(/Mantener sesión abierta/i)).toBeVisible();
  });

  test("destildar checkbox → persiste en localStorage como false", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".login-card", { timeout: 15_000 });

    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.uncheck();

    // Valor en localStorage
    const stored = await page.evaluate(() => localStorage.getItem("pase_remember_me"));
    expect(stored).toBe("false");

    // Volver a tildar y verificar
    await checkbox.check();
    const stored2 = await page.evaluate(() => localStorage.getItem("pase_remember_me"));
    expect(stored2).toBe("true");
  });

  test("F5 después de login mantiene la sesión + el local activo", async ({ page }) => {
    await loginAs(page, "dueno", { local: "Local Prueba 2" });
    // Capturar el local activo del sidebar
    const sidebarLocal = page.locator(".sb-local select").first();
    const localAntes = await sidebarLocal.count()
      ? await sidebarLocal.evaluate(el => (el as HTMLSelectElement).value)
      : null;

    // F5
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Sidebar visible = sigue logueado
    await expect(page.locator(".sb")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".login-card")).not.toBeVisible();

    // Si había local visible, debe seguir siendo el mismo (no defaultearse).
    if (localAntes && await sidebarLocal.count()) {
      const localDespues = await sidebarLocal.evaluate(el => (el as HTMLSelectElement).value);
      expect(localDespues).toBe(localAntes);
    }
  });
});
