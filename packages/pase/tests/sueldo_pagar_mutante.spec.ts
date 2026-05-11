import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: pagar sueldo completo de "Empleado Prueba" desde la UI
// (Tab Pagos en RRHH). Setup vía DB: novedad "confirmada" para enero 2099.
// La RPC pagar_sueldo crea la liquidación on-the-fly (con _generated=true)
// y asienta movimiento + saldos_caja en una sola transacción atómica.
//
// Sentinel entero (la RPC y el UI redondean — un decimal se perdería).
// Año 2099: fuera de rango productivo, garantiza que ninguna data real
// del tenant Neko cae en el filtro mes=1/anio=2099.
const SENTINEL = 567890;
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const CUENTA = "Caja Efectivo";
const MES = 1;     // Enero
const ANIO = 2099;
const MES_LABEL = "Enero";

test.describe("Sueldo — pagar mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let empId: string;
  let saldoCajaInicial: number;
  let novId: string | null = null;
  let liqId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    // Resolver local + tenant_id.
    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    // Pre-check empleado — fail loud con INSERT si falta.
    const { data: emps, error: empErr } = await db
      .from("rrhh_empleados").select("id, sueldo_mensual, alias_mp")
      .eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (empErr) throw new Error(`Error consultando empleados: ${empErr.message}`);
    if (!emps || emps.length === 0) {
      throw new Error(
        `Falta empleado "${APELLIDO}, ${NOMBRE}" en Local Prueba 2 (id=${localId}). Crearlo con:\n` +
        `INSERT INTO rrhh_empleados (apellido, nombre, local_id, tenant_id, sueldo_mensual, puesto, activo, fecha_inicio, alias_mp, aguinaldo_acumulado, vacaciones_dias_acumulados) ` +
        `VALUES ('${APELLIDO}', '${NOMBRE}', ${localId}, '${tenantId}', ${SENTINEL}, 'Test', true, '2099-01-01', NULL, 0, 0);`
      );
    }
    if (emps.length > 1) throw new Error(`Hay ${emps.length} empleados "${APELLIDO} ${NOMBRE}" — desambiguar`);
    empId = emps[0].id as string;
    if (emps[0].sueldo_mensual !== SENTINEL) {
      throw new Error(
        `Empleado Prueba tiene sueldo_mensual=${emps[0].sueldo_mensual}, esperado ${SENTINEL}. Update con:\n` +
        `UPDATE rrhh_empleados SET sueldo_mensual=${SENTINEL} WHERE id='${empId}';`
      );
    }
    if (emps[0].alias_mp !== null) {
      throw new Error(
        `Empleado Prueba tiene alias_mp="${emps[0].alias_mp}". El test asume alias_mp=NULL ` +
        `(el cálculo distribuye 100% a "efectivo" cuando no hay alias). Update con:\n` +
        `UPDATE rrhh_empleados SET alias_mp=NULL WHERE id='${empId}';`
      );
    }

    // Pre-check saldos_caja.
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoCajaInicial = saldoRow.saldo as number;

    // Limpieza idempotente: si un test anterior dejó novedad/liq/mov, removerlos.
    // Orden: mov → liq → nov por FKs.
    const { data: prevNovs } = await db.from("rrhh_novedades")
      .select("id").eq("empleado_id", empId).eq("mes", MES).eq("anio", ANIO);
    const prevNovIds = (prevNovs || []).map(n => n.id as string);
    if (prevNovIds.length > 0) {
      const { data: prevLiqs } = await db.from("rrhh_liquidaciones")
        .select("id").in("novedad_id", prevNovIds);
      const prevLiqIds = (prevLiqs || []).map(l => l.id as string);
      if (prevLiqIds.length > 0) {
        await db.from("movimientos").delete().in("liquidacion_id", prevLiqIds);
        await db.from("rrhh_liquidaciones").delete().in("id", prevLiqIds);
      }
      await db.from("rrhh_novedades").delete().in("id", prevNovIds);
    }

    // INSERT novedad confirmada para enero 2099. presentismo="PIERDE" porque
    // "MANTIENE" suma un 5% de bonus al total — eso descuadraría el assert
    // estricto contra SENTINEL=sueldo_mensual sin tener que hacer math.
    const { data: novIns, error: novErr } = await db.from("rrhh_novedades").insert([{
      empleado_id: empId,
      mes: MES,
      anio: ANIO,
      inasistencias: 0,
      presentismo: "PIERDE",
      horas_extras: 0,
      dobles: 0,
      pagos_dobles_realizados: 0,
      feriados: 0,
      adelantos: 0,
      vacaciones_dias: 0,
      observaciones: "",
      estado: "confirmado",
      tenant_id: tenantId,
    }]).select();
    if (novErr) throw new Error(`Error insertando novedad: ${novErr.message}`);
    novId = novIns![0]!.id as string;

    liqId = null;
    movId = null;

    page.on("dialog", d => { d.accept().catch(() => { /* idempotente */ }); });

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // anular_movimiento: cuando el mov tiene liquidacion_id, también marca
    // rrhh_liquidaciones.anulado=true (verificado en migration 202604281206:988-989).
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", {
          p_mov_id: movId,
          p_motivo: "e2e mutante cleanup",
        });
        if (error && !error.message.includes("YA_ANULADO")) {
           
          console.error(`[cleanup] anular_movimiento(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] anular_movimiento threw:`, e);
      }
    }
    if (movId) {
      try {
        const { error } = await db.from("movimientos").delete().eq("id", movId);
        if (error) {
           
          console.error(`[cleanup] delete movimientos(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete movimientos threw:`, e);
      }
    }
    if (liqId) {
      try {
        const { error } = await db.from("rrhh_liquidaciones").delete().eq("id", liqId);
        if (error) {
           
          console.error(`[cleanup] delete rrhh_liquidaciones(${liqId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete rrhh_liquidaciones threw:`, e);
      }
    }
    if (novId) {
      try {
        const { error } = await db.from("rrhh_novedades").delete().eq("id", novId);
        if (error) {
           
          console.error(`[cleanup] delete rrhh_novedades(${novId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete rrhh_novedades threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("pagar sueldo completo: liquidación pagada, movimiento, saldo caja", async ({ page }) => {
    await goTo(page, "RRHH");

    // Click tab "Pagos".
    await page.locator(".tab", { hasText: "Pagos" }).click();
    await page.waitForTimeout(500);

    // Setear filtros: mes=Enero, año=2099, local=Local Prueba 2. Los 3 son
    // `.search` controles dentro del tab. Identifico por el contenido de
    // sus options para no depender del orden DOM.
    const monthSelect = page.locator("select.search").filter({
      has: page.locator("option", { hasText: MES_LABEL }),
    }).first();
    await monthSelect.selectOption({ value: String(MES) });

    const yearInput = page.locator('input.search[type="number"]').first();
    await yearInput.fill(String(ANIO));

    const localSelect = page.locator("select.search").filter({
      has: page.locator("option", { hasText: LOCAL }),
    }).first();
    await localSelect.selectOption({ label: LOCAL });

    // Esperar que aparezca la fila del Empleado Prueba (loadPagos async).
    const fila = page.locator("tr", { hasText: APELLIDO });
    await fila.waitFor({ state: "visible", timeout: 10_000 });
    await fila.getByRole("button", { name: "Pagar" }).click();

    // Modal "Pagar — Prueba, Empleado".
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });
    const modal = page.locator(".overlay .modal");

    // Línea de pago default: monto pre-cargado al pendiente (= SENTINEL).
    // Solo falta la cuenta. El primer select del modal es el de cuenta de
    // la primera línea de formasPago.
    await modal.locator("select.search").first().selectOption({ label: CUENTA });

    // Botón "Confirmar pago" (cuando es completo). Si fuera parcial diría
    // "Registrar pago parcial" — usamos regex tolerante por las dudas.
    await modal.getByRole("button", { name: /Confirmar pago/i }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Capturar IDs PRIMERO (antes de cualquier assert) ─────────────────
    // Si un assert falla, el afterEach todavía tiene los IDs para limpiar el
    // mov + liq creados por la RPC. Sin esto, los IDs quedan null y el
    // saldo de caja queda mal hasta cleanup manual.
    const { data: liqs, error: liqErr } = await db
      .from("rrhh_liquidaciones")
      .select("id, estado, pagos_realizados, total_a_pagar, anulado")
      .eq("novedad_id", novId);
    if (liqs && liqs.length > 0) liqId = liqs[0]!.id as string;

    const { data: movs, error: movErr } = liqId
      ? await db.from("movimientos")
          .select("id, cuenta, local_id, importe, tipo, cat, liquidacion_id")
          .eq("liquidacion_id", liqId)
      : { data: null, error: null };
    if (movs && movs.length > 0) movId = movs[0]!.id as string;

    // ── Assert 1: liquidación creada y pagada ────────────────────────────
    expect(liqErr).toBeNull();
    expect(liqs?.length).toBe(1);
    expect(liqs?.[0]?.estado).toBe("pagado");
    expect(liqs?.[0]?.pagos_realizados).toBe(SENTINEL);
    expect(liqs?.[0]?.total_a_pagar).toBe(SENTINEL);
    expect(liqs?.[0]?.anulado).not.toBe(true);

    // ── Assert 2: movimiento de pago con importe negativo ───────────────
    expect(movErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.tipo).toBe("Pago Sueldo");
    expect(movs?.[0]?.cat).toBe("SUELDOS");

    // ── Assert 3: saldos_caja bajó por SENTINEL exacto ───────────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoCajaInicial - SENTINEL);
  });
});
