import { type Page } from "@playwright/test";

/**
 * Navega a un módulo del sidebar haciendo click en el item correspondiente.
 */
export async function goTo(page: Page, moduloLabel: string) {
  await page.locator(".nav-item", { hasText: moduloLabel }).click();
  // Esperar a que el contenido principal se actualice
  await page.waitForTimeout(500);
}
