import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Mutante: fn_onboarding_autodetectar (migración 202606131000).
// La RPC marca los pasos de onboarding (tenant_onboarding_progress) cuyo dato
// real ya existe, sin desmarcar nunca, y sin marcar 'completado' automático.
//
// Limitación consciente: el dueño de test (Neko) ya tiene datos reales
// (empleados/insumos/items/canales) → los 5 pasos por-dato dan TRUE. No
// podemos probar FALSE→TRUE sin un tenant fresco (crear/borrar tenant es caro
// + superadmin). Acá validamos: (a) corre sin error y devuelve los 5 flags;
// (b) para Neko los pasos por-dato dan TRUE; (c) es idempotente (2 llamadas =
// mismo resultado, no rompe, no desmarca).
// ─────────────────────────────────────────────────────────────────────────

test.describe("onboarding autodetect (mutante)", () => {
  let db: SupabaseClient;

  test.beforeAll(async () => {
    db = await createDuenoClient();
  });

  test("fn_onboarding_autodetectar marca por dato real, es idempotente y no marca completado", async () => {
    const { data: r1, error: e1 } = await db.rpc("fn_onboarding_autodetectar");
    expect(e1).toBeNull();
    expect(r1).toBeTruthy();
    const p1 = r1 as Record<string, unknown>;

    for (const k of [
      "paso_datos_local",
      "paso_primer_empleado",
      "paso_primer_insumo",
      "paso_primer_item",
      "paso_primer_canal",
    ]) {
      expect(p1).toHaveProperty(k);
    }

    // Neko tiene empleados/insumos/items/canales → esos pasos por-dato son TRUE.
    expect(p1.paso_primer_empleado).toBe(true);
    expect(p1.paso_primer_insumo).toBe(true);
    expect(p1.paso_primer_item).toBe(true);
    expect(p1.paso_primer_canal).toBe(true);

    // 2da corrida: idempotente — mismos flags por-paso, sin desmarcar.
    const { data: r2, error: e2 } = await db.rpc("fn_onboarding_autodetectar");
    expect(e2).toBeNull();
    const p2 = r2 as Record<string, unknown>;
    expect(p2.paso_datos_local).toBe(p1.paso_datos_local);
    expect(p2.paso_primer_empleado).toBe(p1.paso_primer_empleado);
    expect(p2.paso_primer_insumo).toBe(p1.paso_primer_insumo);
    expect(p2.paso_primer_item).toBe(p1.paso_primer_item);
    expect(p2.paso_primer_canal).toBe(p1.paso_primer_canal);
    // NO marca completado automático: no cambia entre corridas.
    expect(p2.completado).toBe(p1.completado);
  });
});
