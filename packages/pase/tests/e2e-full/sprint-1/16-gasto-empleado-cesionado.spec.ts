// ─────────────────────────────────────────────────────────────────────────
// E2E Test 16: gasto a empleado (cesionado/no cesionado) — protege bug Anto
//
// Bug reportado por Anto el 22-may noche: en Gastos → empleados, seleccionar
// un empleado cesionado y tocar Guardar → pantalla congelada sin pasar nada.
//
// Causa: validación de form en línea 261 de Gastos.tsx hacía
//   `if (saving || !form.monto || !form.categoria) return;`
// Para tipo='empleado' el form usa `concepto` (no `categoria`) →
// `form.categoria` queda vacío → return silencioso sin alert.
//
// Fix: validar concepto+empleado_id para tipo=empleado, categoria para resto.
// Este test verifica que la RPC `crear_gasto_empleado` funciona end-to-end
// para ambos: empleado del local actual + empleado cesionado a este local.
// ─────────────────────────────────────────────────────────────────────────

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

test.describe.serial("E2E Test 16 — Gasto empleado cesionado", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("pagar adelanto a empleado del LOCAL PRINCIPAL", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // El empleado mensual del seed ya tiene local_id = local1
    const empleado = seed.empleados.mensual;

    // Snapshot del saldo ANTES del adelanto
    const { data: saldoAntes } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    const saldoPre = Number(saldoAntes?.saldo ?? 0);

    const { data: result, error } = await duenoDb.rpc("crear_gasto_empleado", {
      p_local_id: seed.local1Id,
      p_empleado_id: empleado.id,
      p_concepto: "adelanto",
      p_monto: 15000,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E test adelanto local principal",
    });
    if (error) throw new Error(`crear_gasto_empleado local principal: ${error.message}`);
    expect(result).toBeTruthy();

    // Verificar gasto creado
    const { data: gastos } = await svc.from("gastos")
      .select("monto, tipo, categoria").eq("tenant_id", seed.tenantId).eq("local_id", seed.local1Id);
    expect(gastos!.some(g => g.tipo === "empleado" && Number(g.monto) === 15000)).toBe(true);

    // Verificar adelanto en rrhh_adelantos
    const { data: adels } = await svc.from("rrhh_adelantos")
      .select("id, monto, concepto, empleado_id")
      .eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id);
    const adelantoNuevo = adels!.find(a => Number(a.monto) === 15000 && a.concepto === "adelanto");
    expect(adelantoNuevo).toBeDefined();

    // ─── BUG 23-may: signo del mov debe ser NEGATIVO ──────────────────
    // La RPC crear_gasto_empleado tenía bug de signo (importe = p_monto en
    // lugar de -p_monto) que solo se descubrió cuando Camilo cargó un
    // adelanto a Maria Fernanda y vió el saldo descuadrado. Sin estos asserts
    // el bug se hubiera escapado del Test 16 original (que solo verificaba
    // gasto + adelanto pero no signo del mov ni saldo cache).
    const { data: movsAdel } = await svc.from("movimientos")
      .select("importe, tipo, cat, cuenta, local_id, anulado")
      .eq("adelanto_id_ref", adelantoNuevo!.id);
    expect(movsAdel).toHaveLength(1);
    const movAdel = movsAdel![0]!;
    expect(Number(movAdel.importe)).toBe(-15000);  // ✓ NEGATIVO (egreso)
    expect(movAdel.tipo).toBe("Gasto empleado");    // ✓ consistente, no "egreso" lowercase
    expect(movAdel.cat).toBe("Adelanto");
    expect(movAdel.cuenta).toBe("Caja Efectivo");
    expect(movAdel.local_id).toBe(seed.local1Id);
    expect(movAdel.anulado).toBe(false);

    // Cache de saldos_caja debe haber bajado exactamente -15000.
    // (Antes del trigger sync C4-F16: cache se actualizaba via UPDATE manual
    //  de la RPC. Ahora: trigger AFTER INSERT recalcula desde SUM(movs).)
    const { data: saldoDespues } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(saldoDespues!.saldo)).toBe(saldoPre - 15000);

    await duenoDb.auth.signOut();
  });

  test("pagar adelanto a empleado CESIONADO a otro local", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear cesión: el empleado mensual (local1) se cede a local2
    const empleado = seed.empleados.mensual;
    const { error: cedErr } = await duenoDb.rpc("fn_ceder_empleado_a_local", {
      p_empleado_id: empleado.id,
      p_local_destino_id: seed.local2Id,
      p_tipo: "cesion_temporal",
      p_fecha_desde: new Date().toISOString().slice(0, 10),
      p_fecha_hasta: null,
      p_notas: "E2E test cesion",
    });
    if (cedErr) throw new Error(`fn_ceder_empleado_a_local: ${cedErr.message}`);

    // Verificar que aparece en local2 (cesión). El "local principal" del
    // empleado vive en rrhh_empleados.local_id, no en rrhh_empleado_locales
    // (esa tabla solo guarda las cesiones).
    const { data: cesiones } = await svc.from("rrhh_empleado_locales")
      .select("local_id, es_principal, tipo").eq("empleado_id", empleado.id).is("deleted_at", null);
    const enLocal2 = cesiones!.find(c => c.local_id === seed!.local2Id);
    expect(enLocal2).toBeDefined();
    expect(enLocal2!.tipo).toBe("cesion_temporal");

    // Snapshot saldo Caja Efectivo local2 antes
    const { data: sAntesL2 } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local2Id).eq("cuenta", "Caja Efectivo").single();
    const saldoPreL2 = Number(sAntesL2?.saldo ?? 0);

    // Pagar adelanto desde LOCAL 2 (no su principal) — el cesionado.
    // FIX 25-may: concepto cambiado de 'dia_doble' a 'adelanto'. El sub-test
    // se llama "pagar adelanto" así que semánticamente corresponde adelanto.
    // Antes del fix de crear_gasto_empleado (25-may), cualquier concepto creaba
    // rrhh_adelantos. Ahora solo 'adelanto' lo hace.
    const { data: result, error } = await duenoDb.rpc("crear_gasto_empleado", {
      p_local_id: seed.local2Id,
      p_empleado_id: empleado.id,
      p_concepto: "adelanto",
      p_monto: 12000,
      p_cuenta: "Caja Efectivo",
      p_fecha: new Date().toISOString().slice(0, 10),
      p_detalle: "E2E adelanto cubriendo en Local 2",
    });
    if (error) throw new Error(`crear_gasto_empleado cesionado: ${error.message}`);
    expect(result).toBeTruthy();

    // Verificar gasto en local2
    const { data: gastosL2 } = await svc.from("gastos")
      .select("monto, local_id").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local2Id).eq("tipo", "empleado");
    expect(gastosL2!.some(g => Number(g.monto) === 12000)).toBe(true);

    // El adelanto se graba en rrhh_adelantos sin filtro por local —
    // queda asociado al EMPLEADO. El legajo lo muestra para descontar
    // del próximo sueldo. Verificamos ambos (local1 y local2) suman.
    const { data: adels } = await svc.from("rrhh_adelantos")
      .select("id, monto, cuenta").eq("tenant_id", seed.tenantId).eq("empleado_id", empleado.id);
    const totalAdel = adels!.reduce((s, a) => s + Number(a.monto), 0);
    expect(totalAdel).toBeGreaterThanOrEqual(27000);

    // Asserts de signo + saldo (mismo patrón que test anterior) para
    // proteger contra regresión del bug 23-may.
    const adelLocal2 = adels!.find(a => Number(a.monto) === 12000);
    expect(adelLocal2).toBeDefined();
    const { data: movsL2 } = await svc.from("movimientos")
      .select("importe, tipo, local_id, anulado")
      .eq("adelanto_id_ref", adelLocal2!.id);
    expect(movsL2).toHaveLength(1);
    expect(Number(movsL2![0]!.importe)).toBe(-12000);
    expect(movsL2![0]!.tipo).toBe("Gasto empleado");
    expect(movsL2![0]!.local_id).toBe(seed.local2Id);

    const { data: sDespuesL2 } = await svc.from("saldos_caja")
      .select("saldo").eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local2Id).eq("cuenta", "Caja Efectivo").single();
    expect(Number(sDespuesL2!.saldo)).toBe(saldoPreL2 - 12000);

    await duenoDb.auth.signOut();
  });
});
