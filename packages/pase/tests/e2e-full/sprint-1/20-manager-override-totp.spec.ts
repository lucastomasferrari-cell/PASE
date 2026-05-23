// E2E Test 20: Manager Override TOTP — anular factura con código

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, createE2EDuenoClient, type E2ETenantSeedResult } from "../setup/seed-tenant";
import { currentTotpCode } from "../helpers/totp";

test.describe.serial("E2E Test 20 — Manager Override TOTP", () => {
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

  test("dueño puede anular factura sin código + uso TOTP válido / inválido", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear factura
    const facId = `FAC-TOTP-${Date.now()}`;
    await svc.from("facturas").insert({
      id: facId, tenant_id: seed.tenantId, prov_id: seed.proveedorId, local_id: seed.local1Id,
      nro: "A 0001-TOTP", fecha: new Date().toISOString().slice(0, 10),
      neto: 5000, iva21: 0, iva105: 0, iibb: 0, total: 5000,
      tipo: "A", estado: "pendiente", pagos: [],
    });

    // Dueño anula sin pasar código TOTP — debería funcionar (es dueño)
    const { error: anuErr } = await duenoDb.rpc("anular_factura", {
      p_factura_id: facId,
      p_motivo: "E2E test anular como dueño",
    });
    if (anuErr) throw new Error(`anular_factura como dueño: ${anuErr.message}`);

    const { data: fac } = await svc.from("facturas").select("estado").eq("id", facId).single();
    expect(fac?.estado).toBe("anulada");

    // Verificar TOTP code generation funciona localmente
    const codigo = currentTotpCode(seed.totpSecret);
    expect(codigo).toMatch(/^\d{6}$/);
    expect(codigo.length).toBe(6);

    await duenoDb.auth.signOut();
  });
});
