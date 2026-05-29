// E2E Test 17: crear ticket de soporte desde widget (insert directo)

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
import { loadSharedSeed } from "../setup/shared-seed";

test.describe.serial("E2E Test 17 — Crear ticket soporte", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });
  test("crear ticket bug desde dueño + verificar campos + actualizar estado", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Insert ticket como hace SoporteWidget
    const { data: ticket, error } = await duenoDb.from("tickets_soporte").insert({
      tenant_id: seed.tenantId,
      autor_user_id: seed.duenoUsuarioId,
      autor_email: "dueno-e2e@e2e-test-suite.local",
      autor_rol: "dueno",
      sistema: "pase",
      pantalla_origen: "/equipo",
      mensaje: "E2E test: el botón pagar empleado no responde",
      categoria: "bug",
      prioridad: "media",
      respuesta_llm: "Probablemente sea un bug del frontend.",
      contexto_jsonb: {
        historial: [{ role: "user", content: "el botón pagar empleado no responde" }],
        user_agent: "Mozilla/5.0 E2E Test",
        url_completa: "https://pase-yndx.vercel.app/equipo",
        console_errors: ["TypeError: cannot read properties of null"],
      },
    }).select("id, estado, categoria").single();
    if (error) throw new Error(`Insert ticket: ${error.message}`);
    expect(ticket?.estado).toBe("abierto");
    expect(ticket?.categoria).toBe("bug");

    // Verificar service_role lo ve (como lo haría el admin console)
    const { data: ticketSvc } = await svc.from("tickets_soporte")
      .select("mensaje, autor_rol, prioridad").eq("id", ticket!.id).single();
    expect(ticketSvc?.autor_rol).toBe("dueno");
    expect(ticketSvc?.prioridad).toBe("media");

    // Marcar respondido (lo que haría Lucas desde admin console)
    const { error: updErr } = await svc.from("tickets_soporte")
      .update({ estado: "respondido", atendido_at: new Date().toISOString() })
      .eq("id", ticket!.id);
    if (updErr) throw new Error(`Update ticket: ${updErr.message}`);

    const { data: ticketFin } = await svc.from("tickets_soporte")
      .select("estado, atendido_at").eq("id", ticket!.id).single();
    expect(ticketFin?.estado).toBe("respondido");
    expect(ticketFin?.atendido_at).toBeTruthy();

    await duenoDb.auth.signOut();
  });
});
