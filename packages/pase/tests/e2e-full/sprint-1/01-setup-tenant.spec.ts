// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 1 — Test 01: setup del tenant E2E + 1 operación simple
//
// Este test sienta las bases de toda la suite E2E full:
//   1. Limpia tenant E2E preexistente (idempotencia).
//   2. Crea tenant nuevo "E2E Test Suite (no tocar)" con seed completo.
//   3. Verifica que el seed quedó correcto (tenant + locales + empleados +
//      items + proveedor + TOTP secret + saldos iniciales).
//   4. Genera un código TOTP local y valida que coincide con el de la RPC.
//   5. Cleanup al final: elimina el tenant entero.
//
// El tenant queda con `oculto=TRUE` para que NO aparezca en el selector
// de tenants superadmin de Lucas. Si querés verlo: query con
// `SELECT * FROM tenants WHERE oculto IS TRUE`.
//
// Pre-requisitos:
//   - SUPERADMIN_PASSWORD en packages/pase/.env.local
//   - SUPABASE_SERVICE_KEY en packages/pase/.env.local (para bypassar RLS
//     durante el seed de catálogos y empleados)
//
// Si falta cualquiera de los dos, el test skipea con mensaje accionable.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant,
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  E2E_TENANT_SLUG,
  E2E_DUENO_EMAIL,
  E2E_SENTINEL,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { currentTotpCode } from "../helpers/totp";

test.describe.serial("E2E Sprint 1 — Setup tenant aislado", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.afterAll(async () => {
    // Cleanup garantizado aunque el test falle a mitad.
    try { await cleanupE2ETenant(); } catch (e) {

      console.error("[afterAll] cleanupE2ETenant falló:", e);
    }
  });

  test("crea tenant E2E aislado + seed completo + verifica todo", async ({ request }) => {
    // Gate: superadmin password disponible
    const superdb = await createSuperadminClient();
    if (!superdb) {
      test.skip(true, "SUPERADMIN_PASSWORD no seteado en packages/pase/.env.local. Agregar la línea y reintentar.");
      return;
    }
    const { data: sess } = await superdb.auth.getSession();
    const superToken = sess?.session?.access_token;
    if (!superToken) throw new Error("No se obtuvo token superadmin");

    // ── Limpieza idempotente: si quedó un tenant de un run previo ────────
    await cleanupE2ETenant();

    // ── Act: seedear tenant nuevo desde cero ─────────────────────────────
    // baseUrl viene de Playwright config. Default: http://localhost:5173
    // En CI: la URL del deploy preview.
    const baseUrl = request.url().replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: superToken, baseUrl });

    // ── Assert: estructura básica del seed ───────────────────────────────
    expect(seed.tenantId).toBeTruthy();
    expect(seed.duenoUsuarioId).toBeGreaterThan(0);
    expect(seed.duenoAuthId).toBeTruthy();
    expect(seed.local1Id).toBeGreaterThan(0);
    expect(seed.local2Id).toBeGreaterThan(0);
    expect(seed.local2Id).not.toBe(seed.local1Id);

    // ── Assert: tenant quedó con oculto=TRUE ─────────────────────────────
    const svc = createServiceClient();
    const { data: tenant } = await svc.from("tenants")
      .select("slug, nombre, oculto, activo")
      .eq("id", seed.tenantId)
      .single();
    expect(tenant?.slug).toBe(E2E_TENANT_SLUG);
    expect(tenant?.oculto).toBe(true);
    expect(tenant?.activo).toBe(true);

    // ── Assert: 2 locales con tenant correcto ────────────────────────────
    const { data: locales } = await svc.from("locales")
      .select("id, nombre")
      .eq("tenant_id", seed.tenantId)
      .order("id");
    expect(locales).toHaveLength(2);

    // ── Assert: 3 empleados creados con modo_pago distintos ──────────────
    const { data: empls } = await svc.from("rrhh_empleados")
      .select("id, nombre, cuil, modo_pago")
      .eq("tenant_id", seed.tenantId);
    expect(empls).toHaveLength(3);
    const modos = new Set(empls!.map(e => e.modo_pago));
    expect(modos).toEqual(new Set(["MENSUAL", "QUINCENAL", "JORNAL"]));

    // ── Assert: 5 items de menú ──────────────────────────────────────────
    const { data: items } = await svc.from("items")
      .select("id, nombre, precio")
      .eq("tenant_id", seed.tenantId);
    expect(items).toHaveLength(5);

    // ── Assert: 1 proveedor ──────────────────────────────────────────────
    const { data: provs } = await svc.from("proveedores")
      .select("id, nombre, cuit")
      .eq("tenant_id", seed.tenantId);
    expect(provs).toHaveLength(1);
    expect(provs![0]!.cuit).toBe("30999999999");

    // ── Assert: saldos iniciales (5 cuentas × 2 locales = 10 filas) ──────
    const { data: saldos } = await svc.from("saldos_caja")
      .select("cuenta, local_id, saldo")
      .eq("tenant_id", seed.tenantId);
    expect(saldos).toHaveLength(10);
    for (const s of saldos!) {
      expect(Number(s.saldo)).toBe(0);
    }

    // ── Assert: TOTP secret generado ─────────────────────────────────────
    const { data: totpRow } = await svc.from("tenant_totp_secret")
      .select("secret_base32")
      .eq("tenant_id", seed.tenantId)
      .single();
    expect(totpRow?.secret_base32).toBeTruthy();
    expect((totpRow!.secret_base32 as string).length).toBeGreaterThanOrEqual(16);

    // ── Assert: el código TOTP local coincide con el de la RPC ───────────
    // (esto valida que nuestro helper currentTotpCode funciona)
    const codeLocal = currentTotpCode(totpRow!.secret_base32 as string);
    const { data: codeRpcRow } = await svc.rpc("obtener_codigo_totp_actual", {
      p_tenant_id: seed.tenantId,
    });
    const codeRpc = codeRpcRow as unknown as string;
    expect(codeLocal).toBe(codeRpc);

    // ── Assert: login del dueño E2E funciona y NO ve data de Neko ────────
    const duenoDb = await createE2EDuenoClient();

    const { data: tenantsVisibles } = await duenoDb.from("tenants").select("id, slug");
    // El dueño solo debe ver SU tenant
    const slugs = (tenantsVisibles || []).map(t => t.slug);
    expect(slugs).toContain(E2E_TENANT_SLUG);
    expect(slugs).not.toContain("neko");

    await duenoDb.auth.signOut();
    await superdb.auth.signOut();
  });

  test("invariantes iniciales del tenant E2E recién seedeado", async () => {
    if (!seed) {
      test.skip(true, "Test anterior falló, no hay tenant E2E para verificar");
      return;
    }
    const svc = createServiceClient();

    // INV1 inicial: todos los saldos == 0 (no hubo movs)
    const { data: saldos } = await svc.from("saldos_caja")
      .select("cuenta, saldo")
      .eq("tenant_id", seed.tenantId);
    for (const s of saldos!) {
      expect(Number(s.saldo)).toBe(0);
    }

    // INV2: no hay movimientos
    const { count: movsCount } = await svc.from("movimientos")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId);
    expect(movsCount).toBe(0);

    // INV3: no hay liquidaciones RRHH
    const { count: liqCount } = await svc.from("rrhh_liquidaciones")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId);
    expect(liqCount).toBe(0);

    // INV4: sentinel presente — todas las entidades del seed tienen el marker
    const { data: emplsSentinel } = await svc.from("rrhh_empleados")
      .select("nombre")
      .eq("tenant_id", seed.tenantId);
    for (const e of emplsSentinel!) {
      expect(e.nombre).toContain(E2E_SENTINEL);
    }
  });

  test("cleanup borra el tenant entero sin leftovers", async () => {
    if (!seed) {
      test.skip(true, "Test 1 falló, no hay tenant E2E para limpiar");
      return;
    }

    // Act: limpieza explícita
    await cleanupE2ETenant();

    const svc = createServiceClient();

    // Assert: tenant ya no existe
    const { data: tenant } = await svc.from("tenants")
      .select("id")
      .eq("slug", E2E_TENANT_SLUG)
      .maybeSingle();
    expect(tenant).toBeNull();

    // Assert: 0 locales del tenant E2E
    const { count: localesCount } = await svc.from("locales")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId);
    expect(localesCount).toBe(0);

    // Assert: 0 empleados
    const { count: emplsCount } = await svc.from("rrhh_empleados")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId);
    expect(emplsCount).toBe(0);

    // Assert: 0 saldos_caja
    const { count: saldosCount } = await svc.from("saldos_caja")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", seed.tenantId);
    expect(saldosCount).toBe(0);

    // Marker: ningún usuario tiene email con sentinel
    const { data: usuariosSentinel } = await svc.from("usuarios")
      .select("email")
      .eq("email", E2E_DUENO_EMAIL);
    expect(usuariosSentinel).toHaveLength(0);

    // Reset state para que un re-run sea idempotente
    seed = null;
  });
});
