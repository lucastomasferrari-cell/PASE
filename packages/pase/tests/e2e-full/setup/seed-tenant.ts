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
import crypto from "node:crypto";

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
  // Import lazy para evitar circular import (auth-cache → este archivo).
  const { getCachedAuth, setCachedAuth } = await import("./auth-cache");

  const c = createClient(SUPABASE_URL, loadAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fast path: token cacheado vigente → setSession sin tocar Auth.
  // Resuelve el rate limit: 1 login real por sesión CI en lugar de 85.
  const cached = getCachedAuth(E2E_DUENO_EMAIL);
  if (cached) {
    const { error } = await c.auth.setSession({
      access_token: cached.access_token,
      refresh_token: cached.refresh_token,
    });
    if (!error) return c;
    // Fallback a login real si setSession falla (token revocado).
  }

  // Login real con retry (defensive fallback).
  const backoffs = [0, 2000, 5000, 10000, 20000];
  let lastError: Error | null = null;
  for (const wait of backoffs) {
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { data, error } = await c.auth.signInWithPassword({
      email: E2E_DUENO_EMAIL,
      password: E2E_DUENO_PASSWORD,
    });
    if (!error) {
      if (data.session) {
        setCachedAuth(E2E_DUENO_EMAIL, data.session.access_token, data.session.refresh_token);
      }
      return c;
    }
    lastError = new Error(error.message);
    if (!/rate.?limit/i.test(error.message)) break;
  }
  throw new Error(`Login dueño E2E falló (tras retry): ${lastError?.message ?? "desconocido"}`);
}

// ─── Resultado del seed ────────────────────────────────────────────────
//
// IMPORTANTE: `rrhh_empleados.id` es UUID (no INTEGER) y `items.id` es INTEGER.
// Cuidado al usarlos: el dato en `tenants` y `usuarios` también difiere
// (tenant_id UUID, usuario_id INTEGER).

/**
 * Helper: seedear saldo inicial en una cuenta usando el patrón Opening
 * Balance Adjustment Entry (QuickBooks/Xero).
 *
 * Necesario desde 23-may noche cuando `saldos_caja` pasó a ser cache
 * derivado del ledger `movimientos` via trigger `trg_sync_saldos_caja`.
 * Hacer `UPDATE saldos_caja SET saldo=X` directamente NO funciona porque
 * el primer movimiento del test dispara el trigger que recalcula
 * `saldo = SUM(importe) FROM movimientos` → el saldo manual se pisa.
 *
 * Solución industria: insertar un movimiento "Opening Balance" que
 * REPRESENTE el saldo inicial. Después cualquier mov subsecuente se suma
 * desde ahí.
 *
 * Idempotente: si se llama 2 veces con la misma cuenta+local, reemplaza
 * el opening balance anterior (no acumula).
 *
 * Uso típico en tests:
 *   await seedSaldoInicial(svc, seed.tenantId, seed.local1Id, "Caja Efectivo", 50000);
 *   // → saldo arranca en $50.000 + cualquier mov posterior se calcula bien
 */
export async function seedSaldoInicial(
  svc: SupabaseClient,
  tenantId: string,
  localId: number,
  cuenta: string,
  monto: number,
): Promise<void> {
  // 1. Borrar opening balance anterior si existe (idempotente)
  await svc.from("movimientos")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("local_id", localId)
    .eq("cuenta", cuenta)
    .eq("tipo", "ajuste_inicial")
    .eq("cat", "OPENING_BALANCE");

  // 2. Insertar opening balance nuevo (el trigger recalcula saldos_caja solo)
  const { error } = await svc.from("movimientos").insert({
    id: `OB-${tenantId.slice(0, 8)}-${localId}-${cuenta.replace(/\s+/g, "_")}-${Date.now()}`,
    tenant_id: tenantId,
    local_id: localId,
    cuenta,
    tipo: "ajuste_inicial",
    cat: "OPENING_BALANCE",
    importe: monto,
    detalle: `[E2E SEED] Saldo inicial de ${cuenta}`,
    fecha: new Date().toISOString().slice(0, 10),
    anulado: false,
  });
  if (error) throw new Error(`seedSaldoInicial(${cuenta}=${monto}): ${error.message}`);
}
export interface E2ETenantSeedResult {
  tenantId: string;            // UUID
  duenoUsuarioId: number;       // INTEGER (usuarios.id)
  duenoAuthId: string;          // UUID (auth.users.id)
  local1Id: number;             // INTEGER (locales.id)
  local2Id: number;             // INTEGER
  // Catálogos
  medioEfectivoId: number;
  medioTarjetaId: number;
  medioMpId: number;
  // Empleados (3, todos UUID)
  empleados: {
    mensual: { id: string; nombre: string; apellido: string; cuil: string };
    quincenal: { id: string; nombre: string; apellido: string; cuil: string };
    semanal: { id: string; nombre: string; apellido: string; cuil: string };
  };
  // Items (INTEGER)
  items: { id: number; nombre: string; precio: number }[];
  // Proveedores (INTEGER)
  proveedorId: number;
  // TOTP secret (para que tests puedan generar códigos válidos)
  totpSecret: string;
}

// ─── SEED principal ───────────────────────────────────────────────────
export async function seedE2ETenant(opts: {
  superadminToken: string;
  baseUrl: string; // ej "http://localhost:5173" o "https://pase-yndx.vercel.app"
}): Promise<E2ETenantSeedResult> {
  // NOTA: NO llamamos cleanupE2ETenant() acá porque eso haría un login
  // superadmin internamente y podría invalidar el `superadminToken` recibido.
  // El caller debe limpiar ANTES de pasar el token.

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

  // 5b. Sprint COMANDA Autónomo Fase 4 (24-may noche): crear espejo del
  // dueño en comanda_usuarios con rol_pos='admin' (bypass total POS).
  // Esto es necesario porque fn_check_perm_comanda ahora lee de
  // comanda_usuario_permisos — sin perfil COMANDA, el dueño no puede
  // operar las RPCs POS (fn_cobrar_venta_comanda, etc.).
  const { error: cuErr } = await svc.from("comanda_usuarios").insert({
    tenant_id: tenantId,
    auth_id: duenoAuthId,
    nombre: E2E_DUENO_NOMBRE,
    email: E2E_DUENO_EMAIL,
    rol_pos: "admin",
    locales: null, // todos los locales
    activo: true,
  });
  if (cuErr) throw new Error(`Seed comanda_usuario dueño: ${cuErr.message}`);

  // 6. Seed catálogos
  // medios_cobro: tenant_id default usa auth_tenant_id() que es NULL con
  // service_role → hay que pasarlo explícito.
  const { data: medios, error: mediosErr } = await svc.from("medios_cobro").insert([
    { tenant_id: tenantId, nombre: "EFECTIVO", cuenta_destino: "Caja Efectivo", activo: true },
    { tenant_id: tenantId, nombre: "TARJETA", cuenta_destino: "MercadoPago", activo: true },
    { tenant_id: tenantId, nombre: "MP_QR", cuenta_destino: "MercadoPago", activo: true },
  ]).select("id, nombre");
  if (mediosErr) throw new Error(`Seed medios_cobro: ${mediosErr.message}`);
  const medioEfectivoId = medios!.find(m => m.nombre === "EFECTIVO")!.id as number;
  const medioTarjetaId = medios!.find(m => m.nombre === "TARJETA")!.id as number;
  const medioMpId = medios!.find(m => m.nombre === "MP_QR")!.id as number;

  // Categorías de gastos básicas
  const { error: catErr } = await svc.from("config_categorias").insert([
    { tenant_id: tenantId, nombre: "INSUMOS COCINA", tipo: "gasto_variable", orden: 10, activo: true },
    { tenant_id: tenantId, nombre: "ALQUILER", tipo: "gasto_fijo", orden: 20, activo: true },
    { tenant_id: tenantId, nombre: "SUELDOS", tipo: "gasto_fijo", orden: 30, activo: true },
  ]);
  if (catErr) throw new Error(`Seed config_categorias: ${catErr.message}`);

  // Puestos RRHH (tabla rrhh_puestos: id INTEGER, nombre TEXT, activo BOOL, tenant_id UUID)
  await svc.from("rrhh_puestos").insert([
    { tenant_id: tenantId, nombre: "MOZO", activo: true },
    { tenant_id: tenantId, nombre: "COCINERO", activo: true },
    { tenant_id: tenantId, nombre: "CAJERO", activo: true },
  ]);

  // 7. Seed empleados (3 modos de pago — SEMANAL en lugar de JORNAL que no existe)
  // Schema real:
  //   - id UUID
  //   - apellido TEXT NOT NULL
  //   - nombre TEXT NOT NULL
  //   - puesto TEXT NOT NULL (no FK, texto libre)
  //   - sueldo_mensual NUMERIC NOT NULL
  //   - fecha_inicio DATE (no fecha_alta)
  //   - modo_pago CHECK IN ('MENSUAL', 'QUINCENAL', 'SEMANAL')
  const empleadosData = [
    { nombre: "Mensual", apellido: `${E2E_SENTINEL}`, cuil: "20111111110", puesto: "MOZO", modo_pago: "MENSUAL", sueldo_mensual: 1500000 },
    { nombre: "Quincenal", apellido: `${E2E_SENTINEL}`, cuil: "20222222220", puesto: "COCINERO", modo_pago: "QUINCENAL", sueldo_mensual: 1200000 },
    { nombre: "Semanal", apellido: `${E2E_SENTINEL}`, cuil: "20333333330", puesto: "CAJERO", modo_pago: "SEMANAL", sueldo_mensual: 1000000 },
  ];
  const { data: empleados, error: emplsErr } = await svc.from("rrhh_empleados").insert(
    empleadosData.map(e => ({
      tenant_id: tenantId,
      local_id: local1Id,
      apellido: e.apellido,
      nombre: e.nombre,
      cuil: e.cuil,
      puesto: e.puesto,
      modo_pago: e.modo_pago,
      sueldo_mensual: e.sueldo_mensual,
      fecha_inicio: new Date().toISOString().slice(0, 10),
      activo: true,
    }))
  ).select("id, nombre, apellido, cuil, modo_pago");
  if (emplsErr) throw new Error(`Seed rrhh_empleados: ${emplsErr.message}`);

  const empMensual = empleados!.find(e => e.modo_pago === "MENSUAL")!;
  const empQuincenal = empleados!.find(e => e.modo_pago === "QUINCENAL")!;
  const empSemanal = empleados!.find(e => e.modo_pago === "SEMANAL")!;

  // 8. Seed proveedor (no tiene "activo", solo estado='Activo')
  const { data: proveedor, error: provErr } = await svc.from("proveedores").insert({
    tenant_id: tenantId,
    nombre: `${E2E_SENTINEL} Proveedor`,
    cuit: "30999999999",
    estado: "Activo",
  }).select("id").single();
  if (provErr) throw new Error(`Seed proveedores: ${provErr.message}`);

  // 9. Seed items de menú (5 items)
  // Schema real: items.precio_madre (no "precio"), estado default 'disponible'.
  const itemsData = [
    { nombre: `${E2E_SENTINEL} Sushi Tradicional`, precio: 12000 },
    { nombre: `${E2E_SENTINEL} Roll Especial`, precio: 18000 },
    { nombre: `${E2E_SENTINEL} Bebida`, precio: 3500 },
    { nombre: `${E2E_SENTINEL} Postre`, precio: 5500 },
    { nombre: `${E2E_SENTINEL} Cubierto`, precio: 1000 },
  ];
  const { data: items, error: itemsErr } = await svc.from("items").insert(
    itemsData.map(i => ({
      tenant_id: tenantId,
      nombre: i.nombre,
      precio_madre: i.precio,
      estado: "disponible",
      visible_pos: true,
    }))
  ).select("id, nombre, precio_madre");
  if (itemsErr) throw new Error(`Seed items: ${itemsErr.message}`);

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
  const { error: saldosErr } = await svc.from("saldos_caja").insert(saldosData);
  if (saldosErr) throw new Error(`Seed saldos_caja: ${saldosErr.message}`);

  // 11. Generar TOTP secret del tenant (para tests de manager override).
  // Schema real: `tenant_totp_secret.secret BYTEA` con CHECK octet_length=20.
  // Insertamos 20 bytes random y guardamos también en formato hex string
  // (el seed result expone `totpSecret` como hex para que los tests no tengan
  // que tocar BYTEA serializaciones de Supabase).
  const secretBytes = crypto.randomBytes(20);
  const totpSecret = secretBytes.toString("hex"); // 40 chars hex
  const { error: totpErr } = await svc.from("tenant_totp_secret").insert({
    tenant_id: tenantId,
    secret: `\\x${totpSecret}`, // pg BYTEA literal
  });
  if (totpErr) throw new Error(`Insert tenant_totp_secret: ${totpErr.message}`);

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
      mensual: { id: empMensual.id as string, nombre: empMensual.nombre, apellido: empMensual.apellido, cuil: empMensual.cuil },
      quincenal: { id: empQuincenal.id as string, nombre: empQuincenal.nombre, apellido: empQuincenal.apellido, cuil: empQuincenal.cuil },
      semanal: { id: empSemanal.id as string, nombre: empSemanal.nombre, apellido: empSemanal.apellido, cuil: empSemanal.cuil },
    },
    items: items!.map(i => ({ id: i.id as number, nombre: i.nombre, precio: i.precio_madre as number })),
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
 * IMPORTANTE: `eliminar_tenant_completo` chequea `auth_es_superadmin()` →
 * NO acepta service_role (devuelve NULL en auth). Por eso esta función crea
 * un cliente superadmin a partir de SUPERADMIN_PASSWORD del .env.local.
 * Después del tenant, borra el auth.user del dueño E2E vía service_role.
 *
 * Sin el cleanup del auth.user, un re-run falla con "EMAIL_ALREADY_IN_AUTH"
 * porque /api/crear-tenant rechaza emails ya registrados.
 *
 * Idempotente: si el tenant/auth.user no existen, no rompe.
 *
 * Requiere ambos secrets en packages/pase/.env.local:
 *   - SUPABASE_SERVICE_KEY (para borrar auth.user)
 *   - SUPERADMIN_PASSWORD (para borrar tenant)
 */
export async function cleanupE2ETenant(): Promise<void> {
  // 1. Login superadmin (requerido para eliminar_tenant_completo)
  const anonClient = createClient(SUPABASE_URL, loadAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const superPwd = loadEnv("SUPERADMIN_PASSWORD");
  const { error: loginErr } = await anonClient.auth.signInWithPassword({
    email: "superadmin@pase.local",
    password: superPwd,
  });
  if (loginErr) {

    console.error(`[cleanupE2ETenant] login superadmin falló: ${loginErr.message}`);
    return;
  }

  // 2. Buscar tenant E2E (con superadmin para ver ocultos)
  const { data: tenant } = await anonClient.from("tenants")
    .select("id")
    .eq("slug", E2E_TENANT_SLUG)
    .maybeSingle();

  // 3. Si existe, eliminar tenant completo (via superadmin)
  if (tenant) {
    const { error } = await anonClient.rpc("eliminar_tenant_completo", {
      p_tenant_id: tenant.id,
    });
    if (error) {

      console.error(`[cleanupE2ETenant] eliminar_tenant_completo falló: ${error.message}`);
    }
  }

  await anonClient.auth.signOut();

  // 4. Borrar el auth.user del dueño E2E (via service_role).
  const svc = createServiceClient();
  try {
    const { data: users } = await svc.auth.admin.listUsers({ page: 1, perPage: 100 });
    const target = users?.users?.find(u => u.email === E2E_DUENO_EMAIL);
    if (target) {
      const { error: delErr } = await svc.auth.admin.deleteUser(target.id);
      if (delErr) console.error(`[cleanupE2ETenant] borrar auth.user falló: ${delErr.message}`);
    }
  } catch (e) {

    console.error(`[cleanupE2ETenant] auth admin falló:`, e);
  }

  // 5. Invalidar el cache de auth del dueño E2E — el token cacheado quedó
  //    huérfano (el auth.user que lo emitió ya no existe). Si no limpiamos,
  //    el próximo test va a intentar setSession con un token revocado.
  try {
    const { clearCachedAuth } = await import("./auth-cache");
    clearCachedAuth(E2E_DUENO_EMAIL);
  } catch {
    // No-op si auth-cache no existe (escenario muy raro)
  }
}
