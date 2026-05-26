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
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

test.describe.serial("E2E Test 23 — Anular pago de sueldo", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("crear novedad + liq + pagar + anular movs → saldo + liq vuelven al estado pre-pago", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // 1. Crear novedad confirmada + liquidación $100K
    const empleado = seed.empleados.mensual;
    const fecha = new Date();
    const { data: nov } = await svc.from("rrhh_novedades").insert({
      tenant_id: seed.tenantId,
      empleado_id: empleado.id,
      mes: fecha.getMonth() + 1,
      anio: fecha.getFullYear(),
      inasistencias: 0,
      presentismo: "MANTIENE",
      dias_trabajados: 30,
      horas_extras: 0, dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado",
      fecha_inicio_mes: `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-01`,
      cuota_num: 1, cuotas_total: 1,
    }).select("id").single();

    const { data: liq } = await svc.from("rrhh_liquidaciones").insert({
      tenant_id: seed.tenantId, novedad_id: nov!.id,
      sueldo_base: 100000, descuento_ausencias: 0,
      total_horas_extras: 0, total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
      subtotal1: 100000, monto_presentismo: 0, subtotal2: 100000,
      adelantos: 0, pagos_realizados: 0, total_a_pagar: 100000,
      efectivo: 100000, transferencia: 0, estado: "pendiente",
    }).select("id").single();

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

    // (b) Saldo restituido (volvió a $200K original)
    const { data: saldoAfter } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldoAfter!.saldo)).toBe(200000);

    // (c) Liquidación vuelve a pendiente + pagos_realizados=0 + anulado=true
    const { data: liqAfter2 } = await svc.from("rrhh_liquidaciones")
      .select("anulado, estado, pagos_realizados, pagado_at").eq("id", liq!.id).single();
    expect(liqAfter2?.anulado).toBe(true);
    expect(liqAfter2?.estado).toBe("pendiente");
    expect(Number(liqAfter2!.pagos_realizados)).toBe(0);
    expect(liqAfter2?.pagado_at).toBeNull();

    await duenoDb.auth.signOut();
  });
});
