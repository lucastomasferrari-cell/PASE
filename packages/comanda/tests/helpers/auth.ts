import type { Page } from "@playwright/test";

// Credenciales por rol — mismas que PASE (auth compartido Supabase).
const CREDS: Record<string, { usuario: string; password: string }> = {
  dueno: { usuario: "dueno", password: "Renata2020" },
};

/**
 * Login en COMANDA con el rol indicado.
 * Espera redirect a /catalogo (default post-login) y que el body
 * termine de hidratar (no solo "Cargando...").
 */
export async function loginComanda(
  page: Page,
  rol: "dueno" = "dueno",
) {
  const cred = CREDS[rol];
  if (!cred) throw new Error(`Credenciales no configuradas para rol: ${rol}`);

  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('input[autocomplete="username"]').fill(cred.usuario);
  await page.locator('input[autocomplete="current-password"]').fill(cred.password);
  await page.locator('button[type="submit"]').click();

  // Esperar a salir del /login (Supabase Auth puede tardar 1-3s).
  await page.waitForURL((url) => !/\/login\b/.test(url.toString()), { timeout: 20_000 }).catch(() => {});
  // Esperar a que la app termine de cargar (más allá del splash "Cargando…").
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * Navega a una ruta interna y espera a que termine de cargar (no se quede
 * en el splash "Cargando..."). Útil para tests smoke después del login.
 */
export async function gotoInterno(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  // Esperar a que termine la red (lazy chunks + fetches iniciales).
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  // Asegurarse que el body tenga contenido real, no solo "Cargando…".
  await page.waitForFunction(
    () => {
      const t = document.body.innerText.trim();
      return t.length > 20 && !/^cargando\.?\.?\.?$/i.test(t);
    },
    { timeout: 15_000 },
  ).catch(() => {});
}
