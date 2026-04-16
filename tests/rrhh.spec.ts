import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";

test.describe("RRHH", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "dueno");
    await goTo(page, "RRHH");
    // Esperar que cargue el módulo
    await expect(page.locator(".ph-title", { hasText: "RRHH" })).toBeVisible({ timeout: 10_000 });
  });

  // ═══ TAB EMPLEADOS ═══════════════════════════════════════════════════════

  test.describe("Tab Empleados", () => {
    test.beforeEach(async ({ page }) => {
      await page.locator(".tab", { hasText: "Empleados" }).click();
      await page.waitForTimeout(500);
    });

    test("lista empleados del local seleccionado", async ({ page }) => {
      // Debe haber al menos una tabla con empleados o mensaje de vacío
      const tabla = page.locator("table");
      const empty = page.locator(".empty");
      const hayTabla = await tabla.isVisible().catch(() => false);
      const hayEmpty = await empty.isVisible().catch(() => false);
      expect(hayTabla || hayEmpty).toBeTruthy();
    });

    test("columna vacaciones NO muestra 0.0d para empleados con antigüedad", async ({ page }) => {
      const rows = page.locator("tbody tr");
      const count = await rows.count();
      if (count === 0) {
        test.skip();
        return;
      }
      // Buscar celdas que contengan el patrón de vacaciones (Xd)
      // Al menos un empleado con antigüedad debería tener > 0.0d
      let allZero = true;
      for (let i = 0; i < count; i++) {
        const rowText = await rows.nth(i).innerText();
        // Buscar patrón como "1.2d" o "14.0d" - un número seguido de "d"
        const match = rowText.match(/([\d.]+)d/);
        if (match && parseFloat(match[1]) > 0) {
          allZero = false;
          break;
        }
      }
      // Si hay empleados con antigüedad, no deberían estar todos en 0
      expect(allZero).toBe(false);
    });

    test("botón Legajo abre modal (no navega a otra página)", async ({ page }) => {
      const legajoBtn = page.locator("button", { hasText: "Legajo" }).first();
      const visible = await legajoBtn.isVisible().catch(() => false);
      if (!visible) {
        test.skip();
        return;
      }

      const urlBefore = page.url();
      await legajoBtn.click();

      // Debe abrir un overlay/modal
      await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
      // Esperar a que termine de cargar el legajo
      await expect(page.locator(".overlay .loading")).not.toBeVisible({ timeout: 15_000 });
      // La URL no debe haber cambiado (es modal, no navegación)
      expect(page.url()).toBe(urlBefore);
    });

    test("modal legajo tiene tabs: datos, movimientos, vacaciones, documentos", async ({ page }) => {
      const legajoBtn = page.locator("button", { hasText: "Legajo" }).first();
      const visible = await legajoBtn.isVisible().catch(() => false);
      if (!visible) {
        test.skip();
        return;
      }
      await legajoBtn.click();
      await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
      // Esperar a que termine de cargar
      await expect(page.locator(".overlay .loading")).not.toBeVisible({ timeout: 15_000 });

      // Verificar tabs del legajo
      await expect(page.locator(".overlay .tab", { hasText: "Datos personales" })).toBeVisible();
      await expect(page.locator(".overlay .tab", { hasText: "Movimientos" })).toBeVisible();
      await expect(page.locator(".overlay .tab", { hasText: "Vacaciones" })).toBeVisible();
      await expect(page.locator(".overlay .tab", { hasText: "Documentos" })).toBeVisible();
    });
  });

  // ═══ TAB NOVEDADES ═════════════════════════════════════════════════════════

  test.describe("Tab Novedades", () => {
    test.beforeEach(async ({ page }) => {
      await page.locator(".tab", { hasText: "Novedades" }).click();
      await page.waitForTimeout(500);
    });

    test.skip("como encargado: local se autoselecciona", async ({ page }) => {
      // TODO: necesita credenciales de encargado
    });

    test("seleccionar local → carga empleados con novedades", async ({ page }) => {
      // Como dueño, seleccionar un local
      const localSelect = page.locator("select.search").nth(2); // tercer select (mes, año, local)
      const options = localSelect.locator("option");
      const optCount = await options.count();

      if (optCount <= 1) {
        test.skip();
        return;
      }
      // Seleccionar el primer local real (no "Seleccionar local...")
      await localSelect.selectOption({ index: 1 });
      await page.waitForTimeout(1000);

      // Debe cargar tabla o mensaje vacío
      const tabla = page.locator("table");
      const empty = page.locator(".empty");
      const alert = page.locator(".alert");
      const hayContenido =
        (await tabla.isVisible().catch(() => false)) ||
        (await empty.isVisible().catch(() => false)) ||
        (await alert.isVisible().catch(() => false));
      expect(hayContenido).toBeTruthy();
    });

    test("novedad confirmada → campos bloqueados (disabled)", async ({ page }) => {
      // Seleccionar un local
      const localSelect = page.locator("select.search").nth(2);
      const optCount = await localSelect.locator("option").count();
      if (optCount <= 1) {
        test.skip();
        return;
      }
      await localSelect.selectOption({ index: 1 });
      await page.waitForTimeout(1500);

      // Buscar una fila con badge "OK" (confirmada)
      const okBadge = page.locator("tbody tr .badge", { hasText: "OK" }).first();
      const hasConfirmed = await okBadge.isVisible().catch(() => false);
      if (!hasConfirmed) {
        test.skip();
        return;
      }

      // En la fila confirmada, los inputs deben estar disabled
      const row = okBadge.locator("xpath=ancestor::tr");
      const inputs = row.locator("input");
      const inputCount = await inputs.count();
      if (inputCount > 0) {
        const firstInput = inputs.first();
        await expect(firstInput).toBeDisabled();
      }
    });
  });

  // ═══ TAB PAGOS ═════════════════════════════════════════════════════════════

  test.describe("Tab Pagos", () => {
    test.beforeEach(async ({ page }) => {
      await page.locator(".tab", { hasText: "Pagos" }).click();
      await page.waitForTimeout(500);
    });

    test("seleccionar local → carga datos de pagos", async ({ page }) => {
      const localSelect = page.locator("select.search").nth(2);
      const optCount = await localSelect.locator("option").count();
      if (optCount <= 1) {
        test.skip();
        return;
      }
      await localSelect.selectOption({ index: 1 });
      await page.waitForTimeout(1500);

      // Debe cargar tabla de pagos, o alerta pidiendo confirmar novedades, o vacío
      const tabla = page.locator("table");
      const alert = page.locator(".alert");
      const hayContenido =
        (await tabla.isVisible().catch(() => false)) ||
        (await alert.isVisible().catch(() => false));
      expect(hayContenido).toBeTruthy();
    });

    test("novedad pagada → muestra fecha de pago, sin botón Pagar", async ({ page }) => {
      const localSelect = page.locator("select.search").nth(2);
      const optCount = await localSelect.locator("option").count();
      if (optCount <= 1) {
        test.skip();
        return;
      }
      await localSelect.selectOption({ index: 1 });
      await page.waitForTimeout(1500);

      // Buscar badge de pago con fecha (formato dd/mm/yyyy)
      const pagadoBadge = page.locator("tbody tr .badge.b-success").first();
      const hasPagado = await pagadoBadge.isVisible().catch(() => false);
      if (!hasPagado) {
        test.skip();
        return;
      }

      // En la fila pagada, no debe haber botón "Pagar"
      const row = pagadoBadge.locator("xpath=ancestor::tr");
      const pagarBtn = row.locator("button", { hasText: "Pagar" });
      await expect(pagarBtn).not.toBeVisible();
    });

    test("novedad pendiente → muestra botón Pagar", async ({ page }) => {
      const localSelect = page.locator("select.search").nth(2);
      const optCount = await localSelect.locator("option").count();
      if (optCount <= 1) {
        test.skip();
        return;
      }
      await localSelect.selectOption({ index: 1 });
      await page.waitForTimeout(1500);

      // Buscar badge "Pendiente"
      const pendBadge = page.locator("tbody tr .badge.b-warn", { hasText: "Pendiente" }).first();
      const hasPending = await pendBadge.isVisible().catch(() => false);
      if (!hasPending) {
        test.skip();
        return;
      }

      // En la fila pendiente, debe haber botón "Pagar"
      const row = pendBadge.locator("xpath=ancestor::tr");
      const pagarBtn = row.locator("button", { hasText: "Pagar" });
      await expect(pagarBtn).toBeVisible();
    });
  });

  // ═══ LEGAJO — LIQUIDACIÓN FINAL ════════════════════════════════════════════

  test.describe("Legajo — Liquidación final", () => {
    test("empleado activo → muestra botón Liquidación final en datos", async ({ page }) => {
      await page.locator(".tab", { hasText: "Empleados" }).click();
      await page.waitForTimeout(500);

      // Buscar un empleado activo (badge "Si")
      const activoBadge = page.locator("tbody tr .badge.b-success", { hasText: "Si" }).first();
      const hasActivo = await activoBadge.isVisible().catch(() => false);
      if (!hasActivo) {
        test.skip();
        return;
      }
      // Click en Legajo de esa fila
      const row = activoBadge.locator("xpath=ancestor::tr");
      await row.locator("button", { hasText: "Legajo" }).click();
      await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
      // Esperar que cargue el legajo
      await expect(page.locator(".overlay .loading")).not.toBeVisible({ timeout: 15_000 });

      // En tab "Datos personales" (default), debe existir botón liquidación final
      const liqBtn = page.locator(".overlay button", { hasText: /liquidaci/i });
      await expect(liqBtn).toBeVisible({ timeout: 5_000 });
    });

    test("botón Liquidación final abre modal con desglose", async ({ page }) => {
      await page.locator(".tab", { hasText: "Empleados" }).click();
      await page.waitForTimeout(500);

      const activoBadge = page.locator("tbody tr .badge.b-success", { hasText: "Si" }).first();
      const hasActivo = await activoBadge.isVisible().catch(() => false);
      if (!hasActivo) {
        test.skip();
        return;
      }
      const row = activoBadge.locator("xpath=ancestor::tr");
      await row.locator("button", { hasText: "Legajo" }).click();
      await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
      await expect(page.locator(".overlay .loading")).not.toBeVisible({ timeout: 15_000 });

      const liqBtn = page.locator(".overlay button", { hasText: /liquidaci/i });
      const btnVisible = await liqBtn.isVisible().catch(() => false);
      if (!btnVisible) {
        test.skip();
        return;
      }
      await liqBtn.click();
      await page.waitForTimeout(1000);

      // Debe abrir un segundo modal/overlay con el desglose
      const modalText = await page.locator(".overlay").last().innerText();
      expect(modalText).toContain("Proporcional mes");
      expect(modalText).toContain("Vacaciones");
      expect(modalText).toContain("SAC proporcional");
      expect(modalText).toContain("TOTAL");
    });
  });

  // ═══ DASHBOARD TAB ═════════════════════════════════════════════════════════

  test.describe("Tab Dashboard RRHH", () => {
    test("carga KPIs sin errores", async ({ page }) => {
      // Ya estamos en RRHH, tab dashboard es el default
      await page.waitForSelector(".kpi", { timeout: 10_000 });
      const kpis = page.locator(".kpi");
      const count = await kpis.count();
      expect(count).toBeGreaterThan(0);

      // Verificar que no hay NaN ni undefined
      const text = await page.locator(".main").innerText();
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("undefined");
    });

    test("SAC acumulado NO muestra $0 si hay empleados", async ({ page }) => {
      await page.waitForSelector(".kpi", { timeout: 10_000 });
      // Buscar el KPI de SAC
      const sacKpi = page.locator(".kpi", { hasText: "SAC" });
      const sacVisible = await sacKpi.isVisible().catch(() => false);
      if (!sacVisible) {
        test.skip();
        return;
      }
      const sacText = await sacKpi.innerText();
      // Si hay empleados con sueldo, el SAC acumulado no debería ser $0
      // Buscar el valor monetario - no debe ser $0
      const hasNonZero = /\$\s*[1-9][\d.,]*/.test(sacText);
      expect(hasNonZero).toBe(true);
    });
  });
});
