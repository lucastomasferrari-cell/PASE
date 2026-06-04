import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: cambiar_sueldos_masivo (aumentos masivos) — Lucas 04-jun
//
// La RPC aplica varios cambios de sueldo en una transacción + guarda historial
// por cada uno + idempotency. Acá la probamos contra prod con el "Empleado
// Prueba" de Local Prueba 2 (DB-only, auth real vía createDuenoClient).
//
// Verifica:
//   1. sueldo_mensual quedó en el nuevo valor.
//   2. se creó UNA fila en rrhh_historial_sueldos (anterior→nuevo + motivo).
//   3. idempotency: 2da llamada con misma key → replay, no duplica historial.
// Cleanup: revertir el sueldo al original + borrar la(s) fila(s) de historial.
// ─────────────────────────────────────────────────────────────────────────
const LOCAL = "Local Prueba 2";
const APELLIDO = "Prueba";
const NOMBRE = "Empleado";
const MOTIVO = "e2e mutante aumento masivo";

test.describe("cambiar_sueldos_masivo — mutante", () => {
  let db: SupabaseClient;
  let empId: string;
  let sueldoOriginal: number;
  let nuevoSueldo: number;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales } = await db.from("locales").select("id").eq("nombre", LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    const localId = locales[0].id as number;

    const { data: emps, error } = await db.from("rrhh_empleados")
      .select("id, sueldo_mensual").eq("apellido", APELLIDO).eq("nombre", NOMBRE).eq("local_id", localId);
    if (error) throw new Error(`empleados: ${error.message}`);
    if (!emps || emps.length !== 1) throw new Error(`Empleado "${APELLIDO}, ${NOMBRE}" no único en ${LOCAL}`);
    empId = emps[0].id as string;
    sueldoOriginal = Number(emps[0].sueldo_mensual);
    nuevoSueldo = sueldoOriginal + 12345; // valor distintivo para el cleanup
  });

  test.afterEach(async () => {
    // Revertir sueldo al original (rrhh_empleados no es ledger financiero).
    try { await db.from("rrhh_empleados").update({ sueldo_mensual: sueldoOriginal }).eq("id", empId); }
    catch (e) { console.error("[cleanup] revert sueldo:", e); }
    // Borrar las filas de historial creadas por el test (sueldo_nuevo sentinel).
    try { await db.from("rrhh_historial_sueldos").delete().eq("empleado_id", empId).eq("sueldo_nuevo", nuevoSueldo); }
    catch (e) { console.error("[cleanup] delete historial:", e); }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("aplica el cambio + historial + idempotency", async () => {
    const idemKey = `t-masivo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cambios = [{ emp_id: empId, nuevo_sueldo: nuevoSueldo }];

    const { data: r1, error: e1 } = await db.rpc("cambiar_sueldos_masivo", {
      p_cambios: cambios, p_motivo: MOTIVO, p_idempotency_key: idemKey,
    });
    expect(e1).toBeNull();
    expect((r1 as { ok: boolean }).ok).toBe(true);
    expect((r1 as { cambiados: number }).cambiados).toBe(1);

    // 1. sueldo actualizado
    const { data: emp } = await db.from("rrhh_empleados").select("sueldo_mensual").eq("id", empId).single();
    expect(Number(emp!.sueldo_mensual)).toBe(nuevoSueldo);

    // 2. historial con anterior→nuevo + motivo
    const { data: hist } = await db.from("rrhh_historial_sueldos")
      .select("sueldo_anterior, sueldo_nuevo, motivo")
      .eq("empleado_id", empId).eq("sueldo_nuevo", nuevoSueldo);
    expect(hist!.length).toBe(1);
    expect(Number(hist![0]!.sueldo_anterior)).toBe(sueldoOriginal);
    expect(hist![0]!.motivo).toBe(MOTIVO);

    // 3. idempotency: 2da llamada misma key → replay, no duplica historial
    const { data: r2, error: e2 } = await db.rpc("cambiar_sueldos_masivo", {
      p_cambios: cambios, p_motivo: MOTIVO, p_idempotency_key: idemKey,
    });
    expect(e2).toBeNull();
    expect((r2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);

    const { data: hist2 } = await db.from("rrhh_historial_sueldos")
      .select("id").eq("empleado_id", empId).eq("sueldo_nuevo", nuevoSueldo);
    expect(hist2!.length).toBe(1); // sigue siendo 1, no se duplicó
  });
});
