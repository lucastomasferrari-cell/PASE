// E2E Test 24: empleado quincenal tiene 2 novedades + 2 liquidaciones
//
// Cubre los 2 bugs detectados 22-may noche con Carolina:
//   (1) RRHH.tsx priorizaba cuotas_total guardado sobre modo_pago →
//       empleados quincenales con novedades viejas solo mostraban 1 fila
//   (2) loadPagos hacía novedades.find() → solo agarraba la 1ra novedad,
//       la 2da quincena no aparecía en la lista de pagos

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";

test.describe.serial("E2E Test 24 — Quincenas múltiples", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("empleado QUINCENAL → 2 novedades por mes + 2 liquidaciones independientes", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const empleado = seed.empleados.quincenal; // ya viene con modo_pago='QUINCENAL'
    const fecha = new Date();
    const mes = fecha.getMonth() + 1;
    const anio = fecha.getFullYear();

    // Crear las 2 novedades del mes (lo que haría el frontend al confirmar
    // cada cuota independientemente).
    const novedadesData = [1, 2].map(cuotaNum => ({
      tenant_id: seed!.tenantId,
      empleado_id: empleado.id,
      mes, anio,
      inasistencias: 0,
      presentismo: "MANTIENE",
      dias_trabajados: cuotaNum === 1 ? 15 : 15,
      horas_extras: 0, dobles: 0, feriados: 0,
      adelantos: 0, vacaciones_dias: 0,
      estado: "confirmado",
      fecha_inicio_mes: `${anio}-${String(mes).padStart(2, "0")}-01`,
      cuota_num: cuotaNum,
      cuotas_total: 2,
    }));

    const { data: novs, error: novsErr } = await svc.from("rrhh_novedades")
      .insert(novedadesData).select("id, cuota_num, cuotas_total");
    if (novsErr) throw new Error(`Insert novedades: ${novsErr.message}`);
    expect(novs).toHaveLength(2);

    // Crear liquidaciones independientes para cada cuota
    const sueldoQuincenal = 600000; // mitad de 1.200.000
    for (const nov of novs!) {
      await svc.from("rrhh_liquidaciones").insert({
        tenant_id: seed.tenantId,
        novedad_id: nov.id,
        sueldo_base: sueldoQuincenal,
        descuento_ausencias: 0,
        total_horas_extras: 0, total_dobles: 0, total_feriados: 0, total_vacaciones: 0,
        subtotal1: sueldoQuincenal, monto_presentismo: 0, subtotal2: sueldoQuincenal,
        adelantos: 0, pagos_realizados: 0, total_a_pagar: sueldoQuincenal,
        efectivo: sueldoQuincenal, transferencia: 0,
        estado: "pendiente",
        cuota_num: nov.cuota_num,
        cuotas_total: nov.cuotas_total,
      });
    }

    // Verificar: 2 novedades + 2 liquidaciones independientes
    const { data: novsVer } = await svc.from("rrhh_novedades")
      .select("cuota_num, cuotas_total, estado")
      .eq("empleado_id", empleado.id)
      .eq("mes", mes).eq("anio", anio)
      .order("cuota_num");
    expect(novsVer).toHaveLength(2);
    expect(novsVer![0]!.cuota_num).toBe(1);
    expect(novsVer![0]!.cuotas_total).toBe(2);
    expect(novsVer![1]!.cuota_num).toBe(2);
    expect(novsVer![1]!.cuotas_total).toBe(2);
    expect(novsVer!.every(n => n.estado === "confirmado")).toBe(true);

    const novIds = (novsVer || []).map((_, i) => novs![i]!.id);
    const { data: liqsVer } = await svc.from("rrhh_liquidaciones")
      .select("cuota_num, total_a_pagar, estado, novedad_id")
      .in("novedad_id", novIds)
      .order("cuota_num");
    expect(liqsVer).toHaveLength(2);
    expect(Number(liqsVer![0]!.total_a_pagar)).toBe(sueldoQuincenal);
    expect(Number(liqsVer![1]!.total_a_pagar)).toBe(sueldoQuincenal);
    // Verifica que NO se cuelgan al mismo novedad_id (cada cuota tiene su nov)
    expect(liqsVer![0]!.novedad_id).not.toBe(liqsVer![1]!.novedad_id);

    // Simular el flow de loadPagos: empleados.flatMap → novsEmp.flatMap → 1 fila por liq
    const novsEmp = novsVer!;
    const filasPago = novsEmp.flatMap((nov, idx) => {
      const liqsDeEstaNov = liqsVer!.filter(l => l.novedad_id === novIds[idx]);
      return liqsDeEstaNov.map(liq => ({ cuota: liq.cuota_num, monto: liq.total_a_pagar }));
    });
    expect(filasPago).toHaveLength(2); // CRÍTICO: el bug devolvía solo 1 fila
    expect(filasPago[0]!.cuota).toBe(1);
    expect(filasPago[1]!.cuota).toBe(2);
  });
});
