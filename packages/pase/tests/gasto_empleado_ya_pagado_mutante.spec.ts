import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante (DB-only) — "YA PAGADO" (07-jun).
//
// Verifica el cambio: `crear_gasto_empleado` con un concepto DISTINTO de
// 'adelanto' (acá 'comida') ahora SÍ crea un registro en rrhh_adelantos
// (descontado=FALSE) para que aparezca en la sección "YA PAGADO" de la card
// del sueldo y se pueda tildar/descontar manualmente. Antes (fix 25-may) solo
// 'adelanto' creaba el registro y los demás conceptos quedaban sin rastro en
// el sueldo.
//
// Mutante objetivo: si alguien revierte y vuelve a poner el `IF p_concepto =
// 'adelanto'`, este test falla (no encuentra el registro de 'comida').
const SENTINEL = 234890.11;
const LOCAL = "Local Prueba 2";
const CUENTA = "Caja Efectivo";

test.describe("Gasto empleado YA PAGADO — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let empleadoId: string;
  let gastoId: string | null = null;
  let adelantoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, nombre, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length !== 1) throw new Error(`Se esperaba 1 local "${LOCAL}", hay ${locales?.length ?? 0}`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // Pre-check saldos_caja(Caja Efectivo, localId).
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja").select("saldo").eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila saldos_caja (cuenta="${CUENTA}", local_id=${localId}). Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }

    // Necesitamos un empleado activo del mismo tenant.
    const { data: emps, error: empErr } = await db
      .from("rrhh_empleados").select("id").eq("tenant_id", tenantId).eq("activo", true).limit(1);
    if (empErr) throw new Error(`Error leyendo rrhh_empleados: ${empErr.message}`);
    if (!emps || emps.length === 0) {
      throw new Error(`No hay empleado activo en el tenant de "${LOCAL}" para correr el mutante.`);
    }
    empleadoId = emps[0]!.id as string;

    gastoId = null; adelantoId = null; movId = null;
  });

  test.afterEach(async () => {
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", { p_mov_id: movId, p_motivo: "e2e mutante cleanup" });
        if (error && !error.message.includes("YA_ANULADO")) console.error(`[cleanup] anular_movimiento: ${error.message}`);
      } catch (e) { console.error(`[cleanup] anular threw:`, e); }
      try { await db.from("movimientos").delete().eq("id", movId); } catch (e) { console.error(`[cleanup] del mov:`, e); }
    }
    if (adelantoId) {
      try { await db.from("rrhh_adelantos").delete().eq("id", adelantoId); } catch (e) { console.error(`[cleanup] del adelanto:`, e); }
    }
    if (gastoId) {
      try { await db.from("gastos").delete().eq("id", gastoId); } catch (e) { console.error(`[cleanup] del gasto:`, e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("gasto a empleado concepto='comida' crea registro YA PAGADO tildable", async () => {
    const { data: result, error } = await db.rpc("crear_gasto_empleado", {
      p_local_id: localId,
      p_empleado_id: empleadoId,
      p_concepto: "comida",
      p_monto: SENTINEL,
      p_cuenta: CUENTA,
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E mutante YA PAGADO comida",
    });
    if (error) throw new Error(`crear_gasto_empleado: ${error.message}`);
    const row = (result as Array<{ gasto_id: string; adelanto_id: string }>)[0]!;
    expect(row.gasto_id).toBeTruthy();
    // ── Assert clave: aunque NO es 'adelanto', devuelve adelanto_id ──────────
    expect(row.adelanto_id).toBeTruthy();
    gastoId = row.gasto_id;
    adelantoId = row.adelanto_id;

    // ── El registro existe en rrhh_adelantos con concepto='comida' y NO descontado
    const { data: adel, error: adelErr } = await db
      .from("rrhh_adelantos")
      .select("id, monto, concepto, descontado, empleado_id")
      .eq("id", adelantoId).single();
    expect(adelErr).toBeNull();
    expect(Number(adel!.monto)).toBe(SENTINEL);
    expect(adel!.concepto).toBe("comida");      // ✓ guarda el concepto real
    expect(adel!.descontado).toBe(false);        // ✓ NO se descuenta solo
    expect(adel!.empleado_id).toBe(empleadoId);

    // ── El movimiento de caja está ligado al adelanto, importe negativo ──────
    const { data: movs } = await db
      .from("movimientos").select("id, importe, tipo, cat, anulado").eq("adelanto_id_ref", adelantoId);
    expect(movs).toHaveLength(1);
    movId = movs![0]!.id as string;
    expect(Number(movs![0]!.importe)).toBe(-SENTINEL);
    expect(movs![0]!.cat).toBe("Comida");
    expect(movs![0]!.anulado).toBe(false);

    // ── El gasto existe con tipo='empleado' y categoria='Comida' ─────────────
    const { data: g } = await db.from("gastos").select("tipo, categoria, monto").eq("id", gastoId).single();
    expect(g!.tipo).toBe("empleado");
    expect(g!.categoria).toBe("Comida");
    expect(Number(g!.monto)).toBe(SENTINEL);
  });
});
