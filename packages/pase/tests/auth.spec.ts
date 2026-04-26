import { test, expect } from "@playwright/test";
import { loginAs, logout } from "./helpers/auth";

test.describe("Autenticación", () => {
  test("login con credenciales correctas → redirige al dashboard", async ({ page }) => {
    await loginAs(page, "dueno");
    // Sidebar visible = estamos dentro
    await expect(page.locator(".sb")).toBeVisible();
    // El nav-item Dashboard debe estar activo
    await expect(page.locator(".nav-item.active", { hasText: "Dashboard" })).toBeVisible();
  });

  test("login con credenciales incorrectas → muestra error", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".login-card", { timeout: 15_000 });
    await page.locator('.field input[autocomplete="username"]').fill("dueno");
    await page.locator('.field input[type="password"]').fill("contraseña_mala_123");
    await page.locator("button.btn-acc").click();
    // Debe mostrar error
    await expect(page.locator(".alert-danger")).toBeVisible({ timeout: 10_000 });
    // No debe haber sidebar (no redirigió)
    await expect(page.locator(".sb")).not.toBeVisible();
  });

  test.skip("login como encargado → solo ve sus módulos permitidos", async ({ page }) => {
    // TODO: necesita credenciales de encargado
  });

  test("logout → redirige al login", async ({ page }) => {
    await loginAs(page, "dueno");
    await logout(page);
    // Debe estar en la pantalla de login
    await expect(page.locator(".login-card")).toBeVisible();
    // El sidebar no debe estar visible
    await expect(page.locator(".sb")).not.toBeVisible();
  });

  test("sesión persiste al refrescar (F5)", async ({ page }) => {
    await loginAs(page, "dueno");
    await expect(page.locator(".sb")).toBeVisible();
    // Refrescar
    await page.reload();
    // Debe seguir logueado (sidebar visible, no login)
    await expect(page.locator(".sb")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".login-card")).not.toBeVisible();
  });
});
