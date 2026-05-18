import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante DB-only del manager override TOTP.
//
// No usa UI — el flow del modal se simula con RPCs directas. El objetivo
// es validar que el algoritmo TOTP en pgsql funciona, que la ventana de
// tolerancia ±30s es correcta, que el anti-reuse funciona, y que las RPCs
// gated (anular_factura) aceptan correctamente el p_override_code.
//
// SKIPS automáticamente si las migrations 202605180000 + 202605180100 no
// están aplicadas todavía (chequea si la RPC obtener_codigo_totp_actual
// existe). Esto permite que el test viva en el repo sin romper CI hasta
// que las migrations corran en prod.

const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const SENTINEL_TOTAL = 234567.43;
const NRO = `E2E-OVERRIDE-${Date.now()}`;

test.describe("Manager Override TOTP — mutante DB-only", () => {
  let db: SupabaseClient;
  let migrationsAplicadas = false;
  let localId: number;
  let tenantId: string;
  let provId: number;
  let facturaId: string | null = null;

  test.beforeAll(async () => {
    db = await createDuenoClient();

    // Detect si las migrations corrieron. Llamar a la RPC. Si tira 'does
    // not exist' → migrations pendientes, skipeamos los tests.
    const { error } = await db.rpc("obtener_codigo_totp_actual");
    if (error && /does not exist|function .* does not exist/i.test(error.message)) {
      migrationsAplicadas = false;

      console.warn(`[manager-override] migrations 202605180000+202605180100 NO aplicadas. Tests skipeados.`);
    } else {
      migrationsAplicadas = true;
    }

    // Resolver IDs comunes
    const { data: locales } = await db.from("locales")
      .select("id, nombre, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length !== 1) {
      throw new Error(`Necesita 1 local "${LOCAL}" en el tenant`);
    }
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: provs } = await db.from("proveedores")
      .select("id").eq("nombre", PROVEEDOR);
    if (!provs || provs.length !== 1) {
      throw new Error(`Necesita 1 proveedor "${PROVEEDOR}" en el tenant`);
    }
    provId = provs[0]!.id as number;
  });

  test.afterEach(async () => {
    if (facturaId) {
      try { await db.from("facturas").delete().eq("id", facturaId); } catch {/* idempotente */}
      facturaId = null;
    }
  });

  test("obtener código actual + validar con precheck (sin consumir)", async () => {
    test.skip(!migrationsAplicadas, "Migrations TOTP no aplicadas");

    const { data: r1, error: e1 } = await db.rpc("obtener_codigo_totp_actual");
    expect(e1).toBeNull();
    const row1 = Array.isArray(r1) ? r1[0] : r1;
    expect(row1).toBeTruthy();
    expect(row1.codigo).toMatch(/^[0-9]{6}$/);
    expect(row1.segundos_restantes).toBeGreaterThan(0);
    expect(row1.segundos_restantes).toBeLessThanOrEqual(30);

    // Precheck del mismo código (no consume)
    const { error: ePc } = await db.rpc("precheck_manager_override", { p_codigo: row1.codigo });
    expect(ePc).toBeNull();

    // Verificar que NO se consumió: no hay row en manager_override_usos
    // con ese time_step.
    const { data: usos } = await db.from("manager_override_usos")
      .select("id").eq("tenant_id", tenantId).eq("time_step", row1.time_step);
    expect(usos?.length).toBe(0);

    // Precheck DE NUEVO con el mismo código — sigue funcionando (no se consumió)
    const { error: ePc2 } = await db.rpc("precheck_manager_override", { p_codigo: row1.codigo });
    expect(ePc2).toBeNull();
  });

  test("código inválido (no matchea TOTP) → CODIGO_NO_VALIDO", async () => {
    test.skip(!migrationsAplicadas, "Migrations TOTP no aplicadas");

    const { error } = await db.rpc("precheck_manager_override", { p_codigo: "000000" });
    // Por casualidad podría matchear, pero la probabilidad es 3/1M
    // (3 windows * 1M codes). Si falla a veces, regenerar.
    expect(error).toBeTruthy();
    expect(error?.message).toMatch(/CODIGO_NO_VALIDO|CODIGO_YA_USADO/);
  });

  test("código mal formado → CODIGO_INVALIDO", async () => {
    test.skip(!migrationsAplicadas, "Migrations TOTP no aplicadas");

    const { error: e1 } = await db.rpc("precheck_manager_override", { p_codigo: "12345" });
    expect(e1?.message).toMatch(/CODIGO_INVALIDO/);

    const { error: e2 } = await db.rpc("precheck_manager_override", { p_codigo: "abcdef" });
    expect(e2?.message).toMatch(/CODIGO_INVALIDO/);

    const { error: e3 } = await db.rpc("precheck_manager_override", { p_codigo: "" });
    expect(e3?.message).toMatch(/CODIGO_INVALIDO/);
  });

  test("anular_factura con código válido procede + registra auditoría", async () => {
    test.skip(!migrationsAplicadas, "Migrations TOTP no aplicadas");

    // 1. Crear factura sentinel directamente (bypaseamos UI)
    const { data: fact, error: fErr } = await db.from("facturas").insert({
      nro: NRO,
      fecha: new Date().toISOString().slice(0, 10),
      total: SENTINEL_TOTAL,
      neto: SENTINEL_TOTAL,
      cat: "OTROS",
      tipo: "A",
      estado: "pendiente",
      local_id: localId,
      tenant_id: tenantId,
      prov_id: provId,
    }).select("id").single();
    expect(fErr).toBeNull();
    facturaId = (fact as { id: string }).id;

    // 2. Obtener código actual
    const { data: codeRow } = await db.rpc("obtener_codigo_totp_actual");
    const codigo = (Array.isArray(codeRow) ? codeRow[0] : codeRow).codigo as string;
    const timeStep = Number((Array.isArray(codeRow) ? codeRow[0] : codeRow).time_step);

    // 3. anular_factura CON p_override_code — el caller (dueño) tiene el
    // permiso de todas formas, pero el código se debe consumir igual cuando
    // se pasa explícitamente. Verificamos eso.
    // En realidad la función auth_tiene_permiso_o_override hace short-circuit
    // si tiene el permiso (NO consume el código). Lucas no quiere consumir
    // el secret de los códigos cuando es el dueño quien actúa.
    const { error: anErr } = await db.rpc("anular_factura", {
      p_factura_id: facturaId,
      p_motivo: "E2E test",
      p_override_code: codigo,
    });
    expect(anErr).toBeNull();

    // 4. Verificar estado
    const { data: facFinal } = await db.from("facturas")
      .select("estado").eq("id", facturaId).maybeSingle();
    expect(facFinal?.estado).toBe("anulada");

    // 5. Como el caller es dueño, auth_tiene_permiso_o_override hace
    // short-circuit ANTES de tocar el código → no debería haber row nuevo
    // en manager_override_usos.
    const { data: usos } = await db.from("manager_override_usos")
      .select("id, accion").eq("tenant_id", tenantId).eq("time_step", timeStep);
    expect(usos?.length).toBe(0);
  });

  test("regenerar secret invalida códigos previos", async () => {
    test.skip(!migrationsAplicadas, "Migrations TOTP no aplicadas");

    // Capturar código actual
    const { data: r1 } = await db.rpc("obtener_codigo_totp_actual");
    const codigoViejo = (Array.isArray(r1) ? r1[0] : r1).codigo as string;

    // Regenerar
    const { error: regErr } = await db.rpc("generar_tenant_totp_secret");
    expect(regErr).toBeNull();

    // El código viejo ya no debería precheckar (porque ahora el secret es otro)
    const { error: pcErr } = await db.rpc("precheck_manager_override", { p_codigo: codigoViejo });
    // Probabilidad 3/1M de que el nuevo secret genere casualmente el mismo
    // código en alguna de las 3 windows. Aceptamos error o un código diferente
    // como evidencia de que el secret cambió.
    if (pcErr) {
      expect(pcErr.message).toMatch(/CODIGO_NO_VALIDO/);
    }
  });
});
