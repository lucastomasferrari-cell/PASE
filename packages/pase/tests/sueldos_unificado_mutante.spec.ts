import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: autosave + multi-aspecto del rediseño RRHH TabSueldos.
// Cubre los 3 fixes críticos del 2-jun:
//   1. NovInput draft pattern — tipear número queda persistido en DB
//      (antes se borraba a 0 por parseFloat || 0 con re-render agresivo).
//   2. Presentismo PIERDE — destildar checkbox guarda 'PIERDE' en DB
//      (antes mandaba 'NO_MANTIENE' que violaba constraint → checkbox se
//      re-tildaba solo por re-sync stale).
//   3. Backend constraint — rrhh_novedades.presentismo acepta SOLO
//      'MANTIENE' o 'PIERDE' (migration 202605142200).
//
// El test #1 cubre el autosave fix (race condition mitigada con flag
// debounceTimers.current + savingKeys skip). Si se rompe, el valor
// tipeado se pierde y el assert DB cae.
//
// Patrón: usa Empleado Prueba en Local Prueba 2, año 2099 (fuera de
// rango productivo). Cleanup idempotente en afterEach.

const SENTINEL_SUELDO = 567890;
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const MES = 2;     // Febrero — distinto al sueldo_pagar_mutante (Enero) para no chocar
const ANIO = 2099;
const FALTAS_TIPEADAS = 111;  // Lo que el test tipea

test.describe("TabSueldos — autosave novedades mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let empId: string;
  let novIdsCreated: string[] = [];

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();
    novIdsCreated = [];

    // Resolver local + tenant.
    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    // Pre-check empleado.
    const { data: emps, error: empErr } = await db
      .from("rrhh_empleados").select("id")
      .eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (empErr) throw new Error(`Error consultando empleados: ${empErr.message}`);
    if (!emps || emps.length === 0) {
      throw new Error(
        `Falta "${APELLIDO}, ${NOMBRE}" en Local Prueba 2 (id=${localId}). Crear con:\n` +
        `INSERT INTO rrhh_empleados (apellido, nombre, local_id, tenant_id, sueldo_mensual, puesto, activo, fecha_inicio, alias_mp, aguinaldo_acumulado, vacaciones_dias_acumulados) ` +
        `VALUES ('${APELLIDO}', '${NOMBRE}', ${localId}, '${tenantId}', ${SENTINEL_SUELDO}, 'Test', true, '2099-01-01', NULL, 0, 0);`
      );
    }
    empId = emps[0].id as string;

    // Limpieza idempotente: borrar novedades previas del mes/año test.
    const { data: prevNovs } = await db.from("rrhh_novedades")
      .select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    const prevNovIds = (prevNovs || []).map(n => n.id as string);
    if (prevNovIds.length > 0) {
      // Por si quedó liq + mov de test anterior interrumpido
      const { data: prevLiqs } = await db.from("rrhh_liquidaciones")
        .select("id").in("novedad_id", prevNovIds);
      const prevLiqIds = (prevLiqs || []).map(l => l.id as string);
      if (prevLiqIds.length > 0) {
        await db.from("movimientos").delete().in("liquidacion_id", prevLiqIds);
        await db.from("rrhh_liquidaciones").delete().in("id", prevLiqIds);
      }
      await db.from("rrhh_novedades").delete().in("id", prevNovIds);
    }

    page.on("dialog", d => { d.accept().catch(() => { /* idempotente */ }); });
    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cleanup: borrar novedades creadas durante el test (autosave creó)
    const { data: novs } = await db.from("rrhh_novedades")
      .select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    const ids = [...novIdsCreated, ...(novs || []).map(n => n.id as string)];
    const uniq = Array.from(new Set(ids));
    if (uniq.length > 0) {
      try {
        await db.from("rrhh_novedades").delete().in("id", uniq);
      } catch (e) {

        console.error(`[cleanup] delete novedades:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("MUTANTE: tipear faltas autoguarda en DB (draft pattern + race fix)", async ({ page }) => {
    // 1. Navegar a Equipo (RRHH) → tab Sueldos
    await goTo(page, "RRHH");
    await page.locator(".tab", { hasText: "Sueldos" }).click();
    await page.waitForTimeout(500);

    // 2. Setear filtros: local (mes/año default es actual; el test usa
    //    febrero/2099 que no está en pendientes default → bajamos a Todos
    //    y navegamos al mes).
    const localSelect = page.locator("select.search").first();
    await localSelect.selectOption({ label: LOCAL });
    await page.waitForTimeout(300);

    // Navegar a febrero 2099. Toolbar tiene flechas ← →.
    // Para llegar de "hoy" a feb/2099 es muchísimo — pero el test corre
    // contra tenant aislado E2E donde el empleado solo existe en ese mes.
    // Más simple: usamos botón "Todos" para que muestre el empleado aunque
    // no tenga novedad cargada y el mes esté lejos.
    await page.locator("button", { hasText: "Todos" }).first().click();
    await page.waitForTimeout(300);

    // Click flechas hasta llegar a febrero/2099. En vez de calcular las
    // veces, usamos un loop con cap por seguridad. La toolbar muestra
    // "Mes Año" en el centro — vamos comparando.
    const mesAnioDisplay = page.locator("div").filter({ hasText: /^(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s\d{4}$/ }).first();
    const flechaNext = page.locator("button.btn-ghost.btn-sm", { hasText: "→" });

    // Cap razonable: ~876 clicks máximo (2099-2026=73 años x 12 meses).
    // Si tarda mucho, el test falla por timeout natural.
    for (let i = 0; i < 900; i++) {
      const txt = (await mesAnioDisplay.textContent())?.trim() ?? "";
      if (txt === `Febrero ${ANIO}`) break;
      await flechaNext.click();
      // Necesitamos un pequeño wait después de cada click para que React
      // pueda re-render (sin esto el siguiente click puede no registrar)
      await page.waitForTimeout(20);
    }

    const final = (await mesAnioDisplay.textContent())?.trim() ?? "";
    expect(final).toBe(`Febrero ${ANIO}`);

    await page.waitForTimeout(800);  // settle data load

    // 3. Encontrar la card del empleado y expandir
    const empCard = page.locator(".panel").filter({
      has: page.locator("text=" + `${APELLIDO}, ${NOMBRE}`)
    });
    await expect(empCard).toBeVisible({ timeout: 5000 });

    // Click el header para expandir
    await empCard.locator("div").filter({ hasText: `${APELLIDO}, ${NOMBRE}` }).first().click();
    await page.waitForTimeout(300);

    // 4. Tipear FALTAS_TIPEADAS en el input "Faltas".
    //    El input es un type=number dentro de un label con text "Faltas".
    const faltasInput = empCard.locator("label", { hasText: "Faltas" })
      .locator("input[type='number']").first();
    await expect(faltasInput).toBeVisible({ timeout: 3000 });

    // Click + type — el draft pattern del NovInput captura el focus
    await faltasInput.click();
    await faltasInput.fill(String(FALTAS_TIPEADAS));

    // 5. Wait 1.5s para que dispare el debounce (800ms) + el autosave async
    await page.waitForTimeout(2000);

    // 6. MUTANTE assert: verificar que la novedad existe en DB con inasistencias=FALTAS_TIPEADAS
    const { data: nov, error: novErr } = await db.from("rrhh_novedades")
      .select("id, inasistencias, presentismo")
      .eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO)
      .maybeSingle();

    expect(novErr).toBeNull();
    expect(nov).not.toBeNull();
    if (!nov) throw new Error("Novedad no se creó tras autosave");

    novIdsCreated.push(nov.id as string);

    // Asserts del fix #1 — NovInput draft pattern
    expect(nov.inasistencias).toBe(FALTAS_TIPEADAS);

    // El presentismo se inicializa en 'MANTIENE' por NOV_VACIA default
    expect(nov.presentismo).toBe("MANTIENE");

    // 7. Destildar el checkbox Presentismo
    const presentismoCheck = empCard.locator("label", { hasText: "Presentismo" })
      .locator("input[type='checkbox']").first();
    await expect(presentismoCheck).toBeChecked();
    await presentismoCheck.click();
    await expect(presentismoCheck).not.toBeChecked();  // visualmente debe estar destildado

    // 8. Wait debounce + autosave
    await page.waitForTimeout(2000);

    // 9. MUTANTE assert: presentismo en DB debe ser 'PIERDE' (no 'NO_MANTIENE')
    const { data: nov2 } = await db.from("rrhh_novedades")
      .select("inasistencias, presentismo")
      .eq("id", nov.id).single();

    if (!nov2) throw new Error("Novedad desapareció tras tocar presentismo");

    // Assert del fix #2 — constraint PIERDE (no NO_MANTIENE)
    expect(nov2.presentismo).toBe("PIERDE");

    // Faltas NO debe haberse pisado por el race del autosave
    // (Bug viejo: tocar presentismo disparaba SELECT que pisaba inasistencias=0)
    expect(nov2.inasistencias).toBe(FALTAS_TIPEADAS);

    // 10. Verificar que el checkbox NO se re-tildó solo (bug presentismo).
    //     Espero más tiempo para asegurarme que el useEffect de re-sync no haya
    //     restaurado el state stale.
    await page.waitForTimeout(1000);
    await expect(presentismoCheck).not.toBeChecked();
  });

  test("MUTANTE: backend rechaza presentismo='NO_MANTIENE' (constraint)", async () => {
    // Garantía adicional contra regresión del bug constraint (migration
    // 202605142200): el frontend manda 'PIERDE'; si por error vuelve a
    // mandar 'NO_MANTIENE', el INSERT debe fallar con CHECK violation.
    const { data: locales } = await db.from("locales").select("tenant_id").eq("id", localId).single();
    const tenantId = locales!.tenant_id as string;

    const { error } = await db.from("rrhh_novedades").insert({
      empleado_id: empId,
      mes: MES,
      anio: ANIO,
      inasistencias: 0,
      presentismo: "NO_MANTIENE",  // ⚠️ valor inválido
      horas_extras: 0,
      dobles: 0,
      feriados: 0,
      adelantos: 0,
      vacaciones_dias: 0,
      observaciones: "",
      estado: "borrador",
      tenant_id: tenantId,
    });

    // Debe fallar con check constraint violation
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/check constraint|presentismo/i);
  });

  test("MUTANTE: backend acepta presentismo='PIERDE' y 'MANTIENE'", async () => {
    const { data: locales } = await db.from("locales").select("tenant_id").eq("id", localId).single();
    const tenantId = locales!.tenant_id as string;

    // INSERT con PIERDE debe pasar
    const { data: novP, error: errP } = await db.from("rrhh_novedades").insert({
      empleado_id: empId,
      mes: MES,
      anio: ANIO,
      inasistencias: 0,
      presentismo: "PIERDE",
      horas_extras: 0,
      dobles: 0,
      feriados: 0,
      adelantos: 0,
      vacaciones_dias: 0,
      observaciones: "test pierde",
      estado: "borrador",
      tenant_id: tenantId,
    }).select().single();

    expect(errP).toBeNull();
    if (novP) novIdsCreated.push(novP.id as string);

    // UPDATE a MANTIENE también debe pasar
    if (novP) {
      const { error: errU } = await db.from("rrhh_novedades")
        .update({ presentismo: "MANTIENE" })
        .eq("id", novP.id);
      expect(errU).toBeNull();
    }
  });
});
