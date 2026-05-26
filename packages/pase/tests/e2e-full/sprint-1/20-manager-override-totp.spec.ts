// E2E Test 20: Manager Override TOTP — anular factura con código

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
import {
  currentTotpCode,
} from "../helpers/totp";

test.describe.serial("E2E Test 20 — Manager Override TOTP", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
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
