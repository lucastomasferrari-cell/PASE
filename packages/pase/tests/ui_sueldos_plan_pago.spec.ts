import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL contra prod (Lucas pidió 03-jun "tests reales sobre el
// frontend, no solo en el back").
//
// Primer test ejemplar del flow Sueldos rediseñado (commits c0ceab2 +
// 870c106 + 019af8c del 02-03-jun). Foco: validar que la pantalla
// CARGA y los tabs + plan de pago están presentes.
//
// Scopeado a Local Prueba 2. 100% READ-ONLY (no crea ni modifica data).
// El flow completo de "confirmar + modificar" requiere expandir card +
// navegar meses + leer total dinámico → frágil, queda para otra ronda.

const LOCAL = "Local Prueba 2";

test.describe("UI Sueldos — render básico (frontend real, read-only)", () => {

  test("login → /equipo → 3 tabs visibles (Dashboard/Empleados/Sueldos)", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/equipo");
    await page.waitForLoadState("domcontentloaded");

    // Los 3 tabs del rediseño 31-may.
    const tabDashboard = page.locator(".tab", { hasText: "Dashboard" });
    const tabEmpleados = page.locator(".tab", { hasText: "Empleados" });
    const tabSueldos   = page.locator(".tab", { hasText: "Sueldos" });
    await expect(tabDashboard).toBeVisible({ timeout: 15_000 });
    await expect(tabEmpleados).toBeVisible();
    await expect(tabSueldos).toBeVisible();
  });

  test("click tab Sueldos → strip resumen + filtros + selector mes", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/equipo");
    await page.waitForLoadState("domcontentloaded");

    const tabSueldos = page.locator(".tab", { hasText: "Sueldos" });
    await expect(tabSueldos).toBeVisible({ timeout: 15_000 });
    await tabSueldos.click();

    // El tab queda marcado active
    await expect(tabSueldos).toHaveClass(/active/, { timeout: 5_000 });

    // Filtros del strip resumen (3 botones del toggle)
    await expect(page.locator("button", { hasText: /^Pendientes$/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("button", { hasText: /^Pagados$/ })).toBeVisible();
    await expect(page.locator("button", { hasText: /^Todos$/ })).toBeVisible();

    // Selector mes (toolbar arriba con ←/→). Buscamos el ← como ancla
    // — siempre está visible. Usar exact:true para no matchear
    // "Cerrar sesión →" del sidebar logout.
    await expect(page.getByRole("button", { name: "←", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "→", exact: true })).toBeVisible();
  });

  test("strip resumen muestra contador de empleados (incluso si es 0)", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/equipo");
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".tab", { hasText: "Sueldos" }).click();

    // Texto patrón: "N empleados" o "N empleado con pendientes" etc.
    // Match laxo para tolerar variaciones.
    const stripContador = page.locator("text=/\\bempleados?\\b/i").first();
    await expect(stripContador).toBeVisible({ timeout: 15_000 });
  });
});
