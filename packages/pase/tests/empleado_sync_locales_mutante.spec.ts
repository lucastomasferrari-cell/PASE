import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: trigger AFTER INSERT en rrhh_empleados crea la fila
// principal en rrhh_empleado_locales (Fix 2026-06-02 noche).
//
// Bug reproducido: empleados creados entre el sprint multilocal del
// 20-may y el fix del 02-jun no tenían fila en rrhh_empleado_locales
// porque el UI (RRHH.tsx::guardarEmp) solo hacía INSERT a rrhh_empleados.
//
// Síntoma observable: v_rrhh_empleados_visible devolvía locales_ids=[]
// para esos empleados → el filtro client-side en /gastos los descartaba.
//
// Estos 3 mutantes confirman el fix:
//   1. Crear empleado nuevo via INSERT directo a rrhh_empleados → debe
//      aparecer fila en rrhh_empleado_locales con es_principal=TRUE.
//   2. v_rrhh_empleados_visible devuelve locales_ids con el local_id
//      correcto (no [] ni null).
//   3. UPDATE de rrhh_empleados.local_id refleja en la tabla puente
//      (vieja queda es_principal=FALSE, nueva queda es_principal=TRUE).
//
// Setup: crea su propio empleado de prueba en un local Neko cualquiera.
// Cleanup borra empleado + relaciones.

const SENTINEL_NOMBRE = "TEST_TRIGGER_LOCALES";
const SENTINEL_CUIL_PREFIX = "20-99887766";  // CUIL claramente fake
const LOCAL = "Local Prueba 2";

test.describe("Empleado sync locales mutante", () => {
  let db: SupabaseClient;
  let tenantId: string;
  let localId: number;
  let otroLocalId: number;
  let empleadoId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    empleadoId = null;

    const { data: locales, error: errL } = await db.from("locales")
      .select("id, tenant_id").eq("nombre", LOCAL);
    if (errL) throw new Error(`Consulta local falló: ${errL.message}`);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // Buscar otro local del mismo tenant para el test del UPDATE
    const { data: otros } = await db.from("locales")
      .select("id").eq("tenant_id", tenantId).neq("id", localId).limit(1);
    otroLocalId = (otros?.[0]?.id as number) ?? 0;
  });

  test.afterEach(async () => {
    if (empleadoId) {
      try {
        // Borrar relaciones primero (FK)
        await db.from("rrhh_empleado_locales").delete().eq("empleado_id", empleadoId);
        await db.from("rrhh_empleados").delete().eq("id", empleadoId);
      } catch (e) { console.error("[cleanup]:", e); }
    }
    try { await db.auth.signOut(); } catch { /* idem */ }
  });

  test("MUTANTE: INSERT empleado → trigger crea fila principal en rrhh_empleado_locales", async () => {
    // Replicar el patrón del UI viejo: INSERT directo, sin tocar rrhh_empleado_locales.
    const cuil = `${SENTINEL_CUIL_PREFIX}-${Date.now().toString().slice(-2)}`;
    const { data: emp, error: errIns } = await db.from("rrhh_empleados").insert({
      tenant_id: tenantId,
      local_id: localId,
      nombre: SENTINEL_NOMBRE,
      apellido: "MUTANTE",
      cuil,
      puesto: "test",
      sueldo_mensual: 100000,
      activo: true,
      fecha_inicio: new Date().toISOString().slice(0, 10),
    }).select("id").single();

    expect(errIns).toBeNull();
    empleadoId = emp!.id as string;

    // MUTANTE: si el trigger NO está, NO hay fila en la tabla puente.
    const { data: rels, error: errRel } = await db.from("rrhh_empleado_locales")
      .select("local_id, es_principal, tipo, deleted_at")
      .eq("empleado_id", empleadoId);
    expect(errRel).toBeNull();
    expect(rels).not.toBeNull();
    expect(rels!.length).toBe(1); // MUTANTE: si trigger se rompe, viene 0

    const r = rels![0]!;
    expect(r.local_id).toBe(localId);
    expect(r.es_principal).toBe(true);
    expect(r.tipo).toBe("asignado");
    expect(r.deleted_at).toBeNull();
  });

  test("MUTANTE: v_rrhh_empleados_visible devuelve locales_ids no vacío", async () => {
    const cuil = `${SENTINEL_CUIL_PREFIX}-${Date.now().toString().slice(-2)}V`;
    const { data: emp } = await db.from("rrhh_empleados").insert({
      tenant_id: tenantId,
      local_id: localId,
      nombre: SENTINEL_NOMBRE,
      apellido: "MUTANTE_VISTA",
      cuil,
      puesto: "test",
      sueldo_mensual: 100000,
      activo: true,
      fecha_inicio: new Date().toISOString().slice(0, 10),
    }).select("id").single();
    empleadoId = emp!.id as string;

    // La vista compone locales_ids desde rrhh_empleado_locales. Si el
    // trigger no creó la fila, locales_ids viene [] aquí.
    const { data: vista } = await db.from("v_rrhh_empleados_visible")
      .select("id, locales_ids, local_principal_id")
      .eq("id", empleadoId).single();

    expect(vista).not.toBeNull();
    expect(Array.isArray(vista!.locales_ids)).toBe(true);
    expect((vista!.locales_ids as number[]).length).toBeGreaterThan(0); // MUTANTE: si trigger off, viene []
    expect((vista!.locales_ids as number[]).includes(localId)).toBe(true);
    expect(vista!.local_principal_id).toBe(localId);
  });

  test("MUTANTE: UPDATE local_id refleja en tabla puente", async () => {
    if (!otroLocalId) {
      test.skip(true, "No hay otro local en el tenant para probar UPDATE");
      return;
    }

    const cuil = `${SENTINEL_CUIL_PREFIX}-${Date.now().toString().slice(-2)}U`;
    const { data: emp } = await db.from("rrhh_empleados").insert({
      tenant_id: tenantId,
      local_id: localId,
      nombre: SENTINEL_NOMBRE,
      apellido: "MUTANTE_UPDATE",
      cuil,
      puesto: "test",
      sueldo_mensual: 100000,
      activo: true,
      fecha_inicio: new Date().toISOString().slice(0, 10),
    }).select("id").single();
    empleadoId = emp!.id as string;

    // Cambiar local
    await db.from("rrhh_empleados").update({ local_id: otroLocalId }).eq("id", empleadoId);

    const { data: rels } = await db.from("rrhh_empleado_locales")
      .select("local_id, es_principal, deleted_at")
      .eq("empleado_id", empleadoId)
      .order("local_id");
    expect(rels).not.toBeNull();
    expect(rels!.length).toBeGreaterThanOrEqual(2);  // viejo + nuevo

    const viejo = rels!.find(r => r.local_id === localId);
    const nuevo = rels!.find(r => r.local_id === otroLocalId);

    // MUTANTE: el trigger UPDATE debe marcar el viejo como NO principal
    expect(viejo).toBeDefined();
    expect(viejo!.es_principal).toBe(false);
    expect(viejo!.deleted_at).toBeNull(); // queda como histórico, no se borra

    // MUTANTE: el nuevo queda como principal
    expect(nuevo).toBeDefined();
    expect(nuevo!.es_principal).toBe(true);
    expect(nuevo!.deleted_at).toBeNull();
  });
});
