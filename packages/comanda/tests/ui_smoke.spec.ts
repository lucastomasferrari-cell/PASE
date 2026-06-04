import { test, expect } from "@playwright/test";
import { loginComanda, gotoInterno } from "./helpers/auth";

// Tests UI smoke contra prod (pase-comanda.vercel.app).
// Pedido Lucas 04-jun: "test que funcionen en front end para todo
// comanda" — antes de arrancar a probar la app en operación real.
//
// Scope: 100% READ-ONLY. NO crea ni modifica data. Solo valida que
// cada pantalla principal RENDERIZA sin error 500 / pantalla en
// blanco / chunk-load fail.
//
// Cubre las pantallas críticas del sidebar admin. Las pantallas POS
// (mostrador/salón/handheld) requieren PIN — esos quedan para tests
// más profundos en otra ronda.

const RUTAS_SMOKE: Array<{ label: string; path: string }> = [
  { label: "Catálogo Items", path: "/menu/items" },
  { label: "Catálogo Recetas", path: "/menu/recetas" },
  { label: "Inventario Alertas", path: "/inventario/alertas" },
  { label: "Inventario Conteo", path: "/inventario/conteo" },
  { label: "Salón Mesas", path: "/salon/mesas" },
  { label: "Clientes Lista", path: "/clientes/lista" },
  { label: "Reportes Dashboard", path: "/reportes/dashboard" },
  { label: "Empleados Lista", path: "/empleados/lista" },
  { label: "Marketing Cupones", path: "/marketing/cupones" },
  { label: "Integraciones Mercado Pago", path: "/integraciones/mercadopago" },
];

test.describe("UI Smoke COMANDA — pantallas principales (read-only)", () => {

  test("Login carga sin error", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(/^COMANDA$/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /Iniciar|Ingresar|Entrar/i })).toBeVisible();
  });

  test("Login → redirect a pantalla post-login (sin error 500)", async ({ page }) => {
    await loginComanda(page, "dueno");
    const url = page.url();
    expect(url).not.toMatch(/\/login\b/);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    expect(bodyText.toLowerCase()).not.toContain("error 500");
    expect(bodyText.toLowerCase()).not.toContain("failed to fetch");
  });

  for (const ruta of RUTAS_SMOKE) {
    test(`${ruta.label} → ${ruta.path} renderiza sin error`, async ({ page }) => {
      await loginComanda(page, "dueno");
      await gotoInterno(page, ruta.path);
      const bodyText = await page.locator("body").innerText().catch(() => "");
      // No debe quedar pantalla en blanco ni splash perpetuo
      expect(bodyText.length).toBeGreaterThan(20);
      expect(bodyText.toLowerCase()).not.toMatch(/^cargando\.{0,3}$/);
      // No debe haber errores visibles
      expect(bodyText.toLowerCase()).not.toContain("error 500");
      expect(bodyText.toLowerCase()).not.toContain("failed to fetch");
      expect(bodyText.toLowerCase()).not.toContain("chunkloaderror");
      // La URL final no debe ser /login (no nos kickeó por sesión perdida)
      expect(page.url()).not.toMatch(/\/login\b/);
    });
  }
});
