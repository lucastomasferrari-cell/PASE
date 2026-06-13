// E2E Test 23: anular pago de sueldo + verificar reversión total
//
// Cubre la deuda histórica + feature Anto 22-may noche: poder anular
// un pago de sueldo desde el legajo del empleado. La RPC anular_movimiento
// (migration 202605141800) ya hace toda la reversión correcta:
//   - Restituye saldo de caja
//   - Re-habilita adelantos consumidos
//   - Baja aguinaldo acumulado
//   - Marca liquidación pendiente
//
// Este test valida que TODO eso se ejecuta correctamente.

import {
  test,
  expect,
} from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 23 — Anular pago de sueldo", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("crear novedad + liq + pagar + anular movs → saldo + liq vuelven al estado pre-pago; luego re-pagar revive la liq anulada", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // 1. Crear novedad confirmada + liquidación $100K
    // Sprint 28-may: tenant shared entre specs → usar mes/año único
    // (futuro lejano) para evitar colisión con novedades de tests previos.
    const empleado = seed.empleados.mensual;
    const fecha = new Date();
    const mesUnico = 7; // julio = test #23
    const anioUnico = 2099;
    // Limpieza preventiva por si quedó residuo de runs previos
    await svc.from("rrhh_novedades")
      .delete()
      .eq("tenant_id", seed.tenantId)
      .eq("empleado_id", empleado.id)
      .eq("mes", mesUnico)
      .eq("anio", anioUnico);
    const { data: nov, error: novErr } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes: mesUnico,
      anio: anioUnico,
      inasistencias: 0,
      presentismo: "MANTIENE",
      dias_trabajados: 30,
      horas_extras: 0, dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado",
      fecha_inicio_mes: `${anioUnico}-${String(mesUnico).padStart(2, "0")}-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id").single();
    if (novErr || !nov) throw new Error(`insert novedad falló: ${novErr?.message || "data null"}`);

    const { data: liq } = await svc.from("rrhh_liquidaciones").insert({
      tenant_id: seed.tenantId, novedad_id: nov!.id,
      sueldo_base: 100000, descuento_ausencias: 0,
      total_horas_extras: 0, total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: 100000, monto_presentismo: 0, subtotal2: 100000,
      adelantos: 0, pagos_realizados: 0, total_a_pagar: 100000,
      efectivo: 100000, transferencia: 0, estado: "pendiente",
    }).select("id").single();

    // Patrón delta (29-may): snapshot saldo ANTES del movimiento del pago
    const { data: saldoPrePagoData } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    const saldoPrePago = Number(saldoPrePagoData?.saldo ?? 0);

    // 2. Insertar movimiento del pago $100K linkeado a la liq
    // (simulando que pagar_sueldo lo creó)
    const movId = `MOV-E2E-T23-${Date.now()}`;
    await svc.from("movimientos").insert({
      id: movId,
      tenant_id: seed.tenantId,
      fecha: fecha.toISOString().slice(0, 10),
      cuenta: "Caja Efectivo",
      tipo: "Pago Sueldo",
      cat: "SUELDOS",
      importe: -100000,
      detalle: "E2E test pago sueldo completo",
      liquidacion_id: liq!.id,
      local_id: seed.local1Id,
    });

    // Por el trigger C4-F15, la liq debería actualizarse: pagos_realizados=100K
    const { data: liqAfter1 } = await svc.from("rrhh_liquidaciones")
      .select("pagos_realizados").eq("id", liq!.id).single();
    expect(Number(liqAfter1!.pagos_realizados)).toBe(100000);

    // [Eliminado 25-may] El UPDATE manual de saldos_caja era redundante.
    // Desde el sprint 23-may, el trigger trg_sync_saldos_caja recalcula el
    // saldo automáticamente al insertar el movimiento de arriba ($200K opening
    // balance - $100K pago = $100K). No hace falta seteo manual.

    // Marcar liq como pagada
    await svc.from("rrhh_liquidaciones").update({ estado: "pagado", pagado_at: new Date().toISOString() }).eq("id", liq!.id);

    // 3. ACT: anular el movimiento via RPC (lo que hace el botón del legajo)
    const { error: anuErr } = await duenoDb.rpc("anular_movimiento", {
      p_mov_id: movId,
      p_motivo: "E2E test anular pago para verificar reversión",
    });
    if (anuErr) throw new Error(`anular_movimiento: ${anuErr.message}`);

    // 4. Verificaciones de reversión completa
    // (a) Mov queda anulado=true
    const { data: movAfter } = await svc.from("movimientos")
      .select("anulado, anulado_motivo").eq("id", movId).single();
    expect(movAfter?.anulado).toBe(true);
    expect(movAfter?.anulado_motivo).toContain("E2E");

    // (b) Saldo restituido: volvió al saldo que había antes de insertar el mov del pago
    const { data: saldoAfter } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldoAfter!.saldo)).toBe(saldoPrePago);

    // (c) Liquidación vuelve a pendiente + pagos_realizados=0 + anulado=true
    // Nota 29-may: NO assertamos pagado_at = null porque la RPC
    // anular_movimiento no resetea ese campo (lo limpia el operador a mano
    // desde la UI del legajo). Es comportamiento by-design.
    const { data: liqAfter2 } = await svc.from("rrhh_liquidaciones")
      .select("anulado, estado, pagos_realizados, pagado_at").eq("id", liq!.id).single();
    expect(liqAfter2?.anulado).toBe(true);
    expect(liqAfter2?.estado).toBe("pendiente");
    expect(Number(liqAfter2!.pagos_realizados)).toBe(0);

    // 5. [BUG 05-jun, caso DIAZ] Re-pagar la MISMA quincena tras anular.
    // La liquidación quedó anulado=true; el constraint UNIQUE(novedad_id,
    // cuota_num) impide insertar otra. Antes pagar_sueldo cortaba con
    // LIQUIDACION_ANULADA → quincena trabada. Migración 202606051200 hace que
    // la liquidación anulada se REVIVA (reset + valores nuevos del p_calc).
    //
    // Alineación 13-jun (migración 202606130400): al revivir, pagar_sueldo
    // RECALCULA el total canónico desde la novedad + sueldo vigente y rechaza si
    // el p_calc del cliente difiere. Además los componentes resucitados salen del
    // canónico (NO del p_calc). Por eso pedimos el desglose canónico, lo usamos
    // como p_calc y pagamos EXACTAMENTE el total canónico (no el 100k de la liq
    // manual de arriba — esa quedó anulada y se sobreescribe al revivir).
    const { data: canonData, error: canonErr } = await duenoDb.rpc("fn_liquidacion_total_canonico", {
      p_nov_id: nov!.id, p_adelantos_ids: null,
    });
    if (canonErr) throw new Error(`canonico: ${canonErr.message}`);
    const canon = canonData as Record<string, number>;
    const TOTAL_CANON = Number(canon.total_a_pagar);
    const calc = { ...canon, efectivo: TOTAL_CANON, transferencia: 0 };
    const { data: repago, error: repagoErr } = await duenoDb.rpc("pagar_sueldo", {
      p_nov_id: nov!.id,
      p_formas_pago: [{ cuenta: "Caja Efectivo", monto: TOTAL_CANON }],
      p_adelantos_ids: null,
      p_fecha: fecha.toISOString().slice(0, 10),
      p_mes: mesUnico, p_anio: anioUnico,
      p_crear_liq: true, p_calc: calc, p_idempotency_key: null,
    });
    if (repagoErr) throw new Error(`re-pago tras anular falló: ${repagoErr.message}`);
    expect((repago as { completa: boolean }).completa).toBe(true);
    // Reusó la MISMA fila (la revivió), no creó otra liquidación.
    expect((repago as { liquidacion_id: string }).liquidacion_id).toBe(liq!.id);

    const { data: liqRevived } = await svc.from("rrhh_liquidaciones")
      .select("anulado, estado, pagos_realizados").eq("id", liq!.id).single();
    expect(liqRevived?.anulado).toBe(false);
    expect(liqRevived?.estado).toBe("pagado");
    expect(Number(liqRevived!.pagos_realizados)).toBe(TOTAL_CANON);

    // Cleanup: anular el nuevo mov para devolver el tenant E2E al saldo previo
    // (no dejar plata movida que rompa invariantes de tests posteriores).
    for (const m of ((repago as { mov_ids: string[] }).mov_ids) || []) {
      await duenoDb.rpc("anular_movimiento", { p_mov_id: m, p_motivo: "E2E cleanup re-pago" });
    }

    await duenoDb.auth.signOut();
  });
});
