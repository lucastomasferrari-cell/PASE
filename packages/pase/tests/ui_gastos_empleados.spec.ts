import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

// Test UI REAL — regresión del bug Rene Cantina (fix commit f98ca83):
// en /gastos tipo Empleados con Rene Cantina activo, el dropdown
// estaba vacío. Causa: trigger AFTER INSERT que sincroniza
// rrhh_empleado_locales no estaba creado. Acá validamos contra
// Local Prueba 2 que el dropdown se popula.
//
// Scope: 100% READ-ONLY. No carga gastos.

const LOCAL = "Local Prueba 2";

test.describe("UI Gastos — selector empleados (regresión Rene Cantina)", () => {

  test("login → /gastos → click + Cargar Gasto → tipo Empleados → empleados visibles", async ({ page }) => {
    await loginAs(page, "dueno", { local: LOCAL });
    await page.goto("/gastos");
    await page.waitForLoadState("domcontentloaded");

    // Botón "+ Cargar Gasto" arriba a la derecha
    const btnCargar = page.getByRole("button", { name: /Cargar Gasto/i }).first();
    await expect(btnCargar).toBeVisible({ timeout: 15_000 });
    await btnCargar.click();

    // Modal "Cargar Gasto" abierto
    await expect(page.getByText("Cargar Gasto", { exact: false }).first()).toBeVisible({ timeout: 5_000 });

    // Selector Tipo: cambiar a "Empleados"
    const selectTipo = page.locator("select").filter({ hasText: /Empleados|Fijos/i }).first();
    await selectTipo.selectOption({ label: "Empleados" });

    // Aparece el selector de Concepto + Empleado
    await expect(page.getByText(/Concepto/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Empleado/i).first()).toBeVisible();

    // El dropdown de Empleado debe tener > 1 option (Seleccioná + N empleados).
    // Si el bug del trigger volviera, solo habría 1 option ("Seleccioná...").
    const selectEmpleado = page.locator("select").filter({ has: page.locator('option[value=""]') }).last();
    const optionsCount = await selectEmpleado.locator("option").count();
    expect(optionsCount).toBeGreaterThan(1);
  });
});
