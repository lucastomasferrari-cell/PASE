import type { Page } from "@playwright/test";

// ─── Credenciales por rol ────────────────────────────────────────────────────
const CREDS: Record<string, { usuario: string; password: string }> = {
  dueno: { usuario: "dueno", password: "Renata2020" },
  // TODO: agregar cuando estén disponibles
  // admin:     { usuario: "admin",     password: "..." },
  // encargado: { usuario: "encargado", password: "..." },
};

export interface LoginOpts {
  // Nombre del local a seleccionar tras el login. Si no se pasa: para dueño/admin
  // queda como esté (dropdown sin tocar); para encargado con modal bloqueante,
  // se elige el primer local disponible. Útil para scopear tests mutantes a
  // "Local Prueba" sin ensuciar locales productivos.
  local?: string;
}

/**
 * Login en PASE con el rol indicado.
 * Espera a que el dashboard cargue antes de retornar.
 */
export async function loginAs(
  page: Page,
  rol: "dueno" | "admin" | "encargado",
  opts: LoginOpts = {},
) {
  const cred = CREDS[rol];
  if (!cred) throw new Error(`Credenciales no configuradas para rol: ${rol}`);

  await page.goto("/");
  await page.waitForSelector(".login-card", { timeout: 15_000 });

  await page.locator('.field input[autocomplete="username"]').fill(cred.usuario);
  await page.locator('.field input[type="password"]').fill(cred.password);
  await page.locator("button.btn-acc").click();

  // Tras el submit puede aparecer SeleccionarLocalModal (encargado con >1 local)
  // o pasar directo al sidebar (dueño/admin o encargado con 0/1 local). El
  // modal reusa la clase .login-card pero contiene el texto "Elegí el local".
  const modal = page.locator('.login-card:has-text("Elegí el local")');
  await page.locator('.login-card:has-text("Elegí el local"), .sb').first()
    .waitFor({ state: "visible", timeout: 15_000 });

  if (await modal.isVisible()) {
    const select = modal.locator("select");
    if (opts.local) {
      await select.selectOption({ label: opts.local });
    } else {
      // Smoke tests: tomamos el primer local con value no vacío (la primera
      // option es el placeholder "Seleccioná...").
      const firstId = await select.locator('option[value!=""]').first().getAttribute("value");
      if (!firstId) throw new Error("SeleccionarLocalModal sin opciones");
      await select.selectOption(firstId);
    }
    await modal.locator("button.btn-acc").click();
    await page.waitForSelector(".sb", { timeout: 10_000 });
  } else if (opts.local) {
    // Dueño/admin: sin modal. Si pidieron un local específico, lo elegimos en
    // el dropdown del sidebar (.sb-local). OJO (fix 12-jun): el sidebar ya NO
    // tiene "Todas" (decisión 17-may) — siempre hay UNA sucursal activa, y el
    // default puede ser un local REAL (Neko). El check viejo `if (count())`
    // era un race: si los locales todavía no habían cargado, el select no
    // estaba renderizado y el pedido de local se salteaba EN SILENCIO → el
    // test seguía parado en el local default (así cayó una venta sentinel en
    // Neko el 12-jun). Ahora: esperamos el select y fallamos ruidoso.
    const sidebarSelect = page.locator(".sb-local select");
    try {
      await sidebarSelect.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      throw new Error(
        `loginAs: pidieron local "${opts.local}" pero el selector de sucursal ` +
        `del sidebar (.sb-local select) nunca apareció. Si el usuario tiene un ` +
        `solo local visible el dropdown no se renderiza — en ese caso no pases ` +
        `opts.local. Si tiene varios, esto es un bug de carga del sidebar.`,
      );
    }
    await sidebarSelect.selectOption({ label: opts.local });
    // Verificación: la opción seleccionada es la pedida (falla ruidoso si no).
    const elegido = await sidebarSelect.locator("option:checked").textContent();
    if (elegido?.trim() !== opts.local) {
      throw new Error(`loginAs: se pidió local "${opts.local}" pero quedó seleccionado "${elegido}"`);
    }
  }
}

/**
 * Hace logout y espera la pantalla de login.
 */
export async function logout(page: Page) {
  await page.locator(".sb-logout", { hasText: "Cerrar sesión" }).click();
  await page.waitForSelector(".login-card", { timeout: 10_000 });
}
