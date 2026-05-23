// E2E Test 17: crear ticket de soporte desde widget (insert directo)

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Test 17 — Crear ticket soporte", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

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
