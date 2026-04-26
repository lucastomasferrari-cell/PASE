import { type Page, expect } from "@playwright/test";

// ─── Credenciales por rol ────────────────────────────────────────────────────
const CREDS: Record<string, { usuario: string; password: string }> = {
  dueno: { usuario: "dueno", password: "Renata2020" },
  // TODO: agregar cuando estén disponibles
  // admin:     { usuario: "admin",     password: "..." },
  // encargado: { usuario: "encargado", password: "..." },
};

/**
 * Login en PASE con el rol indicado.
 * Espera a que el dashboard cargue antes de retornar.
 */
export async function loginAs(page: Page, rol: "dueno" | "admin" | "encargado") {
  const cred = CREDS[rol];
  if (!cred) throw new Error(`Credenciales no configuradas para rol: ${rol}`);

  await page.goto("/");
  // Esperar la pantalla de login
  await page.waitForSelector(".login-card", { timeout: 15_000 });

  await page.locator('.field input[autocomplete="username"]').fill(cred.usuario);
  await page.locator('.field input[type="password"]').fill(cred.password);
  await page.locator("button.btn-acc").click();

  // Esperar a que cargue el sidebar (señal de login exitoso)
  await page.waitForSelector(".sb", { timeout: 15_000 });
}

/**
 * Hace logout y espera la pantalla de login.
 */
export async function logout(page: Page) {
  await page.locator(".sb-logout").click();
  await page.waitForSelector(".login-card", { timeout: 10_000 });
}
