// ─────────────────────────────────────────────────────────────────────────
// Seed del tenant E2E Test Suite.
//
// Crea de cero un tenant aislado + locales + usuarios + catálogos + empleados
// + items + recetas + proveedores + saldos iniciales. Usa el endpoint
// /api/crear-tenant (mismo flow que onboarding real) y completa el seed con
// inserts via service-role para minimizar fricción.
//
// El tenant queda con `oculto=TRUE` para que NO aparezca en el listado
// superadmin de Lucas. Para limpiarlo: invocar `cleanupTenant()`.
//
// Convención: cada corrida del Sprint 1 borra y recrea el tenant. Cada
// corrida del "mes operativo" (Sprint 2-3) usa el mismo tenant pero opera
// sobre datos efímeros (sentinel + cleanup al final).
// ─────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ─── Constantes del tenant E2E ─────────────────────────────────────────
export const E2E_TENANT_SLUG = "e2e-test-suite";
export const E2E_TENANT_NOMBRE = "E2E Test Suite (no tocar)";
export const E2E_DUENO_EMAIL = "dueno-e2e@e2e-test-suite.local";
export const E2E_DUENO_PASSWORD = "E2E-Test-2026-DontShareXyz";
export const E2E_DUENO_NOMBRE = "Dueño E2E";
export const E2E_LOCAL_1 = "E2E Local 1";
export const E2E_LOCAL_2 = "E2E Local 2";

// Sentinel para distinguir cualquier data creada por la suite. Si aparece
// un valor con este sentinel en prod (Neko u otros), es leftover de un
// test mal limpiado.
export const E2E_SENTINEL = "__E2E_TEST_SUITE__";

// ─── Setup credentials ────────────────────────────────────────────────
const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";

function loadEnv(key: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!m || !m[1]) throw new Error(`${key} no encontrada en ${envPath}`);
  return m[1].trim();
}

function loadServiceKey(): string {
  // SUPABASE_SERVICE_KEY se usa para bypassear RLS en el seed (necesario para
  // insertar catálogos, empleados, items, etc. sin estar autenticado como
  // dueño del tenant nuevo). Solo en tests locales/CI, nunca en bundle.
  return loadEnv("SUPABASE_SERVICE_KEY");
}

function loadAnonKey(): string {
  return loadEnv("VITE_SUPABASE_ANON_KEY");
}

/**
 * Cliente Supabase con service_role: bypassa RLS. Usar solo para seed/cleanup
 * de tests, nunca para queries productivas.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, loadServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cliente Supabase autenticado como el dueño del tenant E2E. Usar para
 * operaciones del test que requieren JWT real (RPCs con auth check, RLS).
 */
export async function createE2EDuenoClient(): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, loadAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({
    email: E2E_DUENO_EMAIL,
    password: E2E_DUENO_PASSWORD,
  });
  if (error) throw new Error(`Login dueño E2E falló: ${error.message}`);
  return c;
}

// ─── Resultado del seed ────────────────────────────────────────────────
export interface E2ETenantSeedResult {
  tenantId: string;
  duenoUsuarioId: number;
  duenoAuthId: string;
  local1Id: number;
  local2Id: number;
  // Catálogos
  medioEfectivoId: number;
  medioTarjetaId: number;
  medioMpId: number;
  // Empleados (5)
  empleados: {
    mensual: { id: number; nombre: string; cuil: string };
    quincenal: { id: number; nombre: string; cuil: string };
    jornal: { id: number; nombre: string; cuil: string };
  };
  // Items + recetas
  items: { id: number; nombre: string; precio: number }[];
  // Proveedores
  proveedorId: number;
  // TOTP secret (para que tests puedan generar códigos válidos)
  totpSecret: string;
}

// ─── SEED principal ───────────────────────────────────────────────────
export async function seedE2ETenant(opts: {
  superadminToken: string;
  baseUrl: string; // ej "http://localhost:5173" o "https://pase-yndx.vercel.app"
}): Promise<E2ETenantSeedResult> {
  // Limpiar tenant previo si existe (idempotencia)
  await cleanupE2ETenant().catch(() => { /* primer run, no existía */ });

  // 1. Crear tenant via endpoint oficial /api/crear-tenant
  const resp = await fetch(`${opts.baseUrl}/api/crear-tenant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.superadminToken}`,
    },
    body: JSON.stringify({
      nombre: E2E_TENANT_NOMBRE,
      slug: E2E_TENANT_SLUG,
      plan: "trial",
      dueno_email: E2E_DUENO_EMAIL,
      dueno_nombre: E2E_DUENO_NOMBRE,
      dueno_password: E2E_DUENO_PASSWORD,
      local_nombre: E2E_LOCAL_1,
      local_direccion: `${E2E_SENTINEL} dir`,
      trial_dias: 365, // largo, no queremos que expire en test
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`crear-tenant falló (${resp.status}): ${t}`);
  }
  const body = await resp.json();
  const tenantId: string = body.tenant_id;
  const duenoUsuarioId: number = body.usuario_id;
  const local1Id: number = body.local_id;

  const svc = createServiceClient();

  // 2. Marcar tenant como OCULTO (no aparece en listado superadmin)
  const { error: ocultoErr } = await svc.from("tenants")
    .update({ oculto: true })
    .eq("id", tenantId);
  if (ocultoErr) throw new Error(`Setear oculto=true falló: ${ocultoErr.message}`);

  // 3. Crear local 2 (para tests cross-local)
  const { data: local2, error: l2Err } = await svc.from("locales")
    .insert({
      nombre: E2E_LOCAL_2,
      tenant_id: tenantId,
      direccion: `${E2E_SENTINEL} dir 2`,
    })
    .select("id")
    .single();
  if (l2Err) throw new Error(`Crear Local 2 falló: ${l2Err.message}`);
  const local2Id = local2.id as number;

  // 4. Asignar AMBOS locales al dueño en usuario_locales
  await svc.from("usuario_locales")
    .upsert([
      { usuario_id: duenoUsuarioId, local_id: local1Id },
      { usuario_id: duenoUsuarioId, local_id: local2Id },
    ], { onConflict: "usuario_id,local_id" });

  // 5. Obtener auth_id del dueño
  const { data: duenoRow } = await svc.from("usuarios")
    .select("auth_id")
    .eq("id", duenoUsuarioId)
    .single();
  const duenoAuthId = duenoRow!.auth_id as string;

  // 6. Seed catálogos
  const { data: medios } = await svc.from("medios_cobro").insert([
    { tenant_id: tenantId, nombre: "EFECTIVO", cuenta_destino: "Caja Efectivo", activo: true },
    { tenant_id: tenantId, nombre: "TARJETA", cuenta_destino: "MercadoPago", activo: true },
    { tenant_id: tenantId, nombre: "MP_QR", cuenta_destino: "MercadoPago", activo: true },
  ]).select("id, nombre");
  const medioEfectivoId = medios!.find(m => m.nombre === "EFECTIVO")!.id as number;
  const medioTarjetaId = medios!.find(m => m.nombre === "TARJETA")!.id as number;
  const medioMpId = medios!.find(m => m.nombre === "MP_QR")!.id as number;

  // Categorías de gastos básicas
  await svc.from("config_categorias").insert([
    { tenant_id: tenantId, nombre: "INSUMOS COCINA", tipo: "gasto_variable", orden: 10, activo: true },
    { tenant_id: tenantId, nombre: "ALQUILER", tipo: "gasto_fijo", orden: 20, activo: true },
    { tenant_id: tenantId, nombre: "SUELDOS", tipo: "gasto_fijo", orden: 30, activo: true },
  ]);

  // Puestos RRHH
  await svc.from("rrhh_puestos").insert([
    { tenant_id: tenantId, nombre: "MOZO", activo: true },
    { tenant_id: tenantId, nombre: "COCINERO", activo: true },
    { tenant_id: tenantId, nombre: "CAJERO", activo: true },
  ]);

  // 7. Seed empleados (3 modos de pago distintos)
  const empleadosData = [
    { nombre: `${E2E_SENTINEL} Mensual`, cuil: "20111111110", modo_pago: "MENSUAL", sueldo_base: 1500000 },
    { nombre: `${E2E_SENTINEL} Quincenal`, cuil: "20222222220", modo_pago: "QUINCENAL", sueldo_base: 1200000 },
    { nombre: `${E2E_SENTINEL} Jornal`, cuil: "20333333330", modo_pago: "JORNAL", sueldo_base: 50000 },
  ];
  const { data: empleados } = await svc.from("rrhh_empleados").insert(
    empleadosData.map(e => ({
      tenant_id: tenantId,
      local_id: local1Id,
      nombre: e.nombre,
      cuil: e.cuil,
      modo_pago: e.modo_pago,
      sueldo_base: e.sueldo_base,
      fecha_alta: new Date().toISOString().slice(0, 10),
      activo: true,
    }))
  ).select("id, nombre, cuil");

  const empMensual = empleados!.find(e => e.nombre.includes("Mensual"))!;
  const empQuincenal = empleados!.find(e => e.nombre.includes("Quincenal"))!;
  const empJornal = empleados!.find(e => e.nombre.includes("Jornal"))!;

  // 8. Seed proveedor
  const { data: proveedor } = await svc.from("proveedores").insert({
    tenant_id: tenantId,
    nombre: `${E2E_SENTINEL} Proveedor`,
    cuit: "30999999999",
    activo: true,
  }).select("id").single();

  // 9. Seed items de menú (5 items)
  const itemsData = [
    { nombre: `${E2E_SENTINEL} Sushi Tradicional`, precio: 12000 },
    { nombre: `${E2E_SENTINEL} Roll Especial`, precio: 18000 },
    { nombre: `${E2E_SENTINEL} Bebida`, precio: 3500 },
    { nombre: `${E2E_SENTINEL} Postre`, precio: 5500 },
    { nombre: `${E2E_SENTINEL} Cubierto`, precio: 1000 },
  ];
  const { data: items } = await svc.from("items").insert(
    itemsData.map(i => ({
      tenant_id: tenantId,
      nombre: i.nombre,
      precio: i.precio,
      activo: true,
    }))
  ).select("id, nombre, precio");

  // 10. Seed saldos iniciales en saldos_caja para ambos locales
  const cuentas = ["Caja Efectivo", "Caja Chica", "Caja Mayor", "MercadoPago", "Banco"];
  const saldosData = [];
  for (const lid of [local1Id, local2Id]) {
    for (const cuenta of cuentas) {
      saldosData.push({
        tenant_id: tenantId,
        local_id: lid,
        cuenta,
        saldo: 0,
        visible_roles: ["dueno", "admin", "encargado"],
      });
    }
  }
  await svc.from("saldos_caja").insert(saldosData);

  // 11. Generar TOTP secret del tenant (para tests de manager override)
  const { data: totpRow, error: totpErr } = await svc.rpc("generar_tenant_totp_secret", {
    p_tenant_id: tenantId,
  });
  if (totpErr) throw new Error(`Generar TOTP falló: ${totpErr.message}`);
  // generar_tenant_totp_secret devuelve el secret en base32; lo cacheamos
  // para que el test pueda calcular el código actual con `currentTotpCode(secret)`.
  const totpSecret = totpRow as unknown as string;

  return {
    tenantId,
    duenoUsuarioId,
    duenoAuthId,
    local1Id,
    local2Id,
    medioEfectivoId,
    medioTarjetaId,
    medioMpId,
    empleados: {
      mensual: { id: empMensual.id as number, nombre: empMensual.nombre, cuil: empMensual.cuil },
      quincenal: { id: empQuincenal.id as number, nombre: empQuincenal.nombre, cuil: empQuincenal.cuil },
      jornal: { id: empJornal.id as number, nombre: empJornal.nombre, cuil: empJornal.cuil },
    },
    items: items!.map(i => ({ id: i.id as number, nombre: i.nombre, precio: i.precio as number })),
    proveedorId: proveedor!.id as number,
    totpSecret,
  };
}

// ─── CLEANUP del tenant ───────────────────────────────────────────────
/**
 * Elimina el tenant E2E entero. Usa la RPC `eliminar_tenant_completo` que
 * desactiva los triggers append-only de auditoria y borra todas las tablas
 * con tenant_id en orden topológico + el tenant.
 *
 * Idempotente: si el tenant no existe, no rompe.
 */
export async function cleanupE2ETenant(): Promise<void> {
  const svc = createServiceClient();
  const { data: tenant } = await svc.from("tenants")
    .select("id")
    .eq("slug", E2E_TENANT_SLUG)
    .maybeSingle();
  if (!tenant) return; // No existía, nada que hacer.

  const { error } = await svc.rpc("eliminar_tenant_completo", {
    p_tenant_id: tenant.id,
  });
  if (error) {
    // No throw: queremos que el cleanup sea best-effort. Log para diagnosticar.

    console.error(`[cleanupE2ETenant] eliminar_tenant_completo falló: ${error.message}`);
  }
}
