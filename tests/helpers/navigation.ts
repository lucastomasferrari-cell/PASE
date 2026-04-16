import { type Page } from "@playwright/test";

/**
 * Navega a un módulo del sidebar haciendo click en el item correspondiente.
 */
export async function goTo(page: Page, moduloLabel: string) {
  const navItem = page.locator(".nav-item", { hasText: moduloLabel });
  await navItem.waitFor({ state: "visible", timeout: 10_000 });
  await navItem.click();
  // Esperar a que el contenido principal se actualice
  await page.waitForTimeout(500);
}
