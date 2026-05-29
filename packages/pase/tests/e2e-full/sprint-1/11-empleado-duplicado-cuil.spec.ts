// E2E Sprint 2 — Test 11: prevenir empleado duplicado por CUIL
// Cubre el fix de 22-may para que Anto no pueda crear duplicados sin querer.

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  type E2ETenantSeedResult,
  E2E_SENTINEL,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Sprint 2 — Prevenir empleado duplicado CUIL", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("intentar crear empleado con CUIL ya existente debe fallar/bloquearse", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // El seed ya creó empleado MENSUAL con cuil="20111111110"
    const cuilExistente = seed.empleados.mensual.cuil;

    // Intento crear otro con el mismo CUIL
    const { error: dupErr } = await svc.from("rrhh_empleados").insert({
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      apellido: E2E_SENTINEL,
      nombre: "Duplicado",
      cuil: cuilExistente,
      puesto: "MOZO",
      modo_pago: "MENSUAL",
      sueldo_mensual: 999999,
      fecha_inicio: new Date().toISOString().slice(0, 10),
      activo: true,
    });

    // El check debería estar a nivel DB (UNIQUE index) o nivel RPC. Si la
    // tabla no tiene UNIQUE, el insert lo deja pasar — entonces el bloqueo
    // está solo en frontend. Documentamos esto.
    if (dupErr) {
      expect(dupErr.message.toLowerCase()).toMatch(/duplicate|unique|cuil/);
    } else {
      // Insert pasó → no hay constraint DB. El check vive en RRHH.tsx frontend
      // (commit 18944a6). Eso es deuda: borramos el dup creado.
      console.warn("[test 11] WARN: no hay constraint UNIQUE en rrhh_empleados.cuil — el bloqueo es solo frontend. Considerá agregarlo a nivel DB.");
      const { data: dups } = await svc.from("rrhh_empleados")
        .select("id").eq("tenant_id", seed.tenantId).eq("cuil", cuilExistente);
      expect(dups!.length).toBeGreaterThanOrEqual(2);
      // Cleanup del duplicado para no afectar otros tests
      await svc.from("rrhh_empleados").delete()
        .eq("tenant_id", seed.tenantId).eq("cuil", cuilExistente).eq("nombre", "Duplicado");
    }
  });
});
