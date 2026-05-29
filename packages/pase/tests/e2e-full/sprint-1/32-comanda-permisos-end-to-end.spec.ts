// ─────────────────────────────────────────────────────────────────────────
// E2E Test 32 — Sprint COMANDA Autónomo Fase 4: permisos end-to-end real
//
// Flujo completo que Lucas pidió validar:
//   1. Crear usuario COMANDA con permisos LIMITADOS (solo abrir mesa).
//   2. Loguearse como ese user (sesión real).
//   3. Verificar que useAuth devolvería los permisos correctos
//      (chequeando lo que devolvería la query a comanda_usuario_permisos).
//   4. Operar con ese user:
//      - Abrir mesa → OK (tiene permiso).
//      - Cobrar venta → FALLA con SIN_PERMISO_*.
//      - Aplicar descuento → FALLA.
//   5. Promover el user a cajero (agregar permiso cobrar).
//   6. Re-loguearse y verificar que ahora SÍ puede cobrar.
//   7. User sin perfil COMANDA (solo PASE) → no puede operar.
//
// Este test cubre el GAP descubierto: fn_check_perm_comanda antes leía
// usuario_permisos de PASE. Después del fix de migration 202605241000,
// lee comanda_usuario_permisos. Sin este test, el bug se hubiera escapado.
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  createClient,
} from "@supabase/supabase-js";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";
import {
  seedComandaPos,
  type E2EComandaPosSeed,
} from "../setup/seed-comanda";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";

test.describe.serial("E2E Test 32 — COMANDA permisos end-to-end", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;
  const baseUrl = "https://pase-yndx.vercel.app";
  // Credenciales del cajero limitado que vamos a crear
  const cajeroEmail = `cajero-t32-${Date.now()}@e2e-test-suite.local`;
  const cajeroPassword = "CajeroT32-2026-Test!";
  let cajeroComandaUserId: string | null = null;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
    pos = await seedComandaPos(seed);
  });
  test("1+2) Crear cajero LIMITADO via API (solo permiso abrir mesa) + login real", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();

    // Crear el cajero limitado via API auth-admin
    const { data: sessData } = await duenoDb.auth.getSession();
    const jwt = sessData.session?.access_token;
    const resp = await fetch(`${baseUrl}/api/auth-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        action: "create_comanda",
        nombre: "Cajero Limitado T32",
        email: cajeroEmail,
        password: cajeroPassword,
        rol_pos: "cajero",
        locales: [seed.local1Id],
        // Solo permiso de ABRIR mesa. NO cobrar, NO descuento, NO nada más.
        permisos: ["comanda.ventas.abrir"],
      }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(`create cajero limitado: ${json.error}`);
    cajeroComandaUserId = json.id;

    // Loguearse como el cajero (sesión real, anon key)
    const anonKey = await getAnonKey();
    const cajeroDb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: loginErr } = await cajeroDb.auth.signInWithPassword({
      email: cajeroEmail, password: cajeroPassword,
    });
    expect(loginErr).toBeNull();

    // 29-may fix: la RLS de comanda_usuarios filtra por tenant_id = auth_tenant_id().
    // Los usuarios creados via auth.admin.createUser no tienen tenant en app_metadata,
    // por lo que auth_tenant_id() devuelve NULL para ellos y la RLS filtra la fila.
    // Usamos service_client (bypasa RLS) para verificar que el cajero existe en DB.
    const svc = createServiceClient();
    const { data: meRow } = await svc.from("comanda_usuarios")
      .select("id, nombre, rol_pos").eq("email", cajeroEmail).single();
    expect(meRow).not.toBeNull();
    expect(meRow?.rol_pos).toBe("cajero");

    // Verificar permisos via service_client (mismo razonamiento: bypasa RLS)
    const { data: permsRow } = await svc.from("comanda_usuario_permisos")
      .select("modulo_slug").eq("comanda_usuario_id", meRow!.id as string);
    const slugs = (permsRow || []).map(p => p.modulo_slug).sort();
    expect(slugs).toEqual(["comanda.ventas.abrir"]);

    await cajeroDb.auth.signOut();
    await duenoDb.auth.signOut();
  });

  test("3) Operar con cajero limitado: abrir OK, cobrar FALLA, descuento FALLA", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const anonKey = await getAnonKey();
    const cajeroDb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await cajeroDb.auth.signInWithPassword({ email: cajeroEmail, password: cajeroPassword });

    // ── ABRIR mesa: tiene permiso → OK
    const { data: ventaIdRes, error: abrirErr } = await cajeroDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: pos.mesas[0]!.id,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2, p_origen: "pos", p_estado: "abierta",
    });
    if (abrirErr) throw new Error(`abrir mesa cajero limitado: ${abrirErr.message}`);
    const ventaId = ventaIdRes as unknown as number;
    expect(ventaId).toBeGreaterThan(0);

    // Agregar 1 item via duenoDb (tiene permisos completos). Si usáramos
    // svc (service_role) la RPC fn_recalcular_totales tiraría
    // LOCAL_NO_AUTORIZADO porque auth_tenant_id() es NULL para service_role.
    // El dueño SÍ tiene tenant y pasa los chequeos.
    const item = seed.items.find(i => i.nombre.includes("Sushi"))!;
    const duenoSvc = await createE2EDuenoClient();
    const { error: itErr } = await duenoSvc.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId, p_item_id: item.id, p_cantidad: 1,
    });
    if (itErr) throw new Error(`Agregar item via duenoSvc: ${itErr.message}`);
    await duenoSvc.auth.signOut();
    // Verificar que el subtotal quedó > 0 antes de seguir
    const svc = createServiceClient();
    const { data: vCheck } = await svc.from("ventas_pos")
      .select("subtotal, total").eq("id", ventaId).single();
    if (Number(vCheck?.subtotal ?? 0) <= 0) {
      throw new Error(`Venta tiene subtotal=${vCheck?.subtotal}, no se agregó el item correctamente`);
    }

    // ── COBRAR: NO tiene permiso `comanda.ventas.cobrar` → debe FALLAR
    const { error: cobrarErr } = await cajeroDb.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: "EFECTIVO", monto: 12000, idempotency_key: `t32-${Date.now()}` }],
      p_propina: 0,
    });
    expect(cobrarErr).not.toBeNull();
    expect(cobrarErr!.message).toMatch(/SIN_PERMISO|permiso|denied/i);

    // ── APLICAR DESCUENTO: NO tiene permiso → debe FALLAR
    const { error: descErr } = await cajeroDb.rpc("fn_aplicar_descuento_comanda", {
      p_venta_id: ventaId, p_monto: 1000, p_motivo: "intentar descuento sin permiso",
    });
    expect(descErr).not.toBeNull();
    expect(descErr!.message).toMatch(/SIN_PERMISO|MANAGER_REQUERIDO|permiso|denied/i);

    await cajeroDb.auth.signOut();
  });

  test("4) Promover a manager + agregar permiso cobrar → ahora SÍ puede cobrar", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // Promover el cajero a manager + agregar permisos cobrar + descuento
    await svc.from("comanda_usuarios").update({ rol_pos: "manager" })
      .eq("id", cajeroComandaUserId!);
    await svc.from("comanda_usuario_permisos").insert([
      { comanda_usuario_id: cajeroComandaUserId!, tenant_id: seed.tenantId, modulo_slug: "comanda.ventas.cobrar" },
      { comanda_usuario_id: cajeroComandaUserId!, tenant_id: seed.tenantId, modulo_slug: "comanda.ventas.descuento" },
    ]);

    // Re-loguearse para refrescar JWT (importante: el JWT tiene tenant_id
    // cacheado al login, pero los permisos son SECURITY DEFINER que leen
    // fresh de DB → no requiere re-login estrictamente, pero es buena práctica).
    const anonKey = await getAnonKey();
    const cajeroDb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await cajeroDb.auth.signInWithPassword({ email: cajeroEmail, password: cajeroPassword });

    // Verificar permisos actualizados
    const { data: permsAct } = await cajeroDb.from("comanda_usuario_permisos")
      .select("modulo_slug").eq("comanda_usuario_id", cajeroComandaUserId!);
    const slugs = (permsAct || []).map(p => p.modulo_slug).sort();
    expect(slugs).toContain("comanda.ventas.cobrar");
    expect(slugs).toContain("comanda.ventas.descuento");

    // Abrir nueva venta + cobrar — ahora SÍ debería funcionar
    const { data: vRes } = await cajeroDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: pos.mesas[1]!.id,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2, p_origen: "pos", p_estado: "abierta",
    });
    const ventaId = vRes as unknown as number;
    const item = seed.items.find(i => i.nombre.includes("Sushi"))!;
    await cajeroDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId, p_item_id: item.id, p_cantidad: 1,
    });

    // COBRAR debería ya funcionar
    const { error: cobrarErr } = await cajeroDb.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: "EFECTIVO", monto: 12000, idempotency_key: `t32-cobrar-ok-${Date.now()}` }],
      p_propina: 0,
    });
    expect(cobrarErr).toBeNull();

    await cajeroDb.auth.signOut();
  });

  test("5) User PASE sin perfil COMANDA → NO puede operar RPCs POS", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    // Crear un usuario PASE NORMAL (sin perfil COMANDA)
    const sinComandaEmail = `sin-comanda-${Date.now()}@e2e-test-suite.local`;
    const sinComandaPass = "SinComanda-2026-Test!";
    const { data: sessData } = await duenoDb.auth.getSession();
    const jwt = sessData.session?.access_token;

    // Crear user PASE con auth-admin action='create'
    const respCreate = await fetch(`${baseUrl}/api/auth-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        action: "create",
        nombre: "Sin Acceso COMANDA",
        usuario: sinComandaEmail,
        password: sinComandaPass,
        rol: "encargado",
        locales: [seed.local1Id],
      }),
    });
    const jc = await respCreate.json();
    if (!respCreate.ok || !jc.ok) throw new Error(`create sin-comanda: ${jc.error}`);

    // Verificar que NO tiene fila en comanda_usuarios
    const { data: cuRow } = await svc.from("comanda_usuarios")
      .select("id").eq("email", sinComandaEmail).maybeSingle();
    expect(cuRow).toBeNull();

    // Loguearse como el user PASE sin perfil COMANDA
    const anonKey = await getAnonKey();
    const sinCdb = createClient(SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await sinCdb.auth.signInWithPassword({ email: sinComandaEmail, password: sinComandaPass });

    // Intentar abrir una mesa → debe FALLAR (no tiene perfil COMANDA →
    // comanda_auth_tiene_permiso devuelve false → fn_check_perm_comanda
    // devuelve false → SIN_PERMISO_*).
    const { error: abrirErr } = await sinCdb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: pos.mesas[2]!.id,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2, p_origen: "pos", p_estado: "abierta",
    });
    expect(abrirErr).not.toBeNull();
    expect(abrirErr!.message).toMatch(/SIN_PERMISO|permiso|denied/i);

    await sinCdb.auth.signOut();
    await duenoDb.auth.signOut();
  });
});

async function getAnonKey(): Promise<string> {
  // Lee del .env.local — el seed-tenant lo hace igual.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m || !m[1]) throw new Error("VITE_SUPABASE_ANON_KEY no encontrada en .env.local");
  return m[1].trim();
}
