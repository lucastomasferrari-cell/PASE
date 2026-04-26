import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

test.describe("Persistencia de sesión", () => {
  test("login → refrescar → sigue en dashboard", async ({ page }) => {
    await loginAs(page, "dueno");
    await expect(page.locator(".sb")).toBeVisible();
    // Verificar que estamos en dashboard
    await expect(page.locator(".nav-item.active", { hasText: "Dashboard" })).toBeVisible();

    await page.reload();
    // Debe restaurar sesión y mostrar dashboard
    await expect(page.locator(".sb")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".login-card")).not.toBeVisible();
  });

  test("login → nueva pestaña misma URL → sigue logueado", async ({ page, context }) => {
    await loginAs(page, "dueno");
    await expect(page.locator(".sb")).toBeVisible();

    // Abrir nueva pestaña en el mismo contexto (comparte localStorage)
    const newPage = await context.newPage();
    await newPage.goto("/");
    // Debe restaurar sesión automáticamente
    await expect(newPage.locator(".sb")).toBeVisible({ timeout: 15_000 });
    await newPage.close();
  });

  test("sesión usa localStorage → persiste entre pestañas", async ({ page }) => {
    await loginAs(page, "dueno");
    // Verificar que pase_uid está en localStorage
    const uid = await page.evaluate(() => localStorage.getItem("pase_uid"));
    expect(uid).toBeTruthy();
    expect(Number(uid)).toBeGreaterThan(0);
  });
});
