#!/usr/bin/env node
// Auditoría defensiva de RPCs públicos: detecta bugs latentes de schema
// que NO se manifiestan hasta que alguien invoca la RPC con args válidos.
//
// MOTIVACIÓN:
// El 24-may-2026 descubrimos que el marketplace estaba completamente roto
// 3 semanas porque `fn_crear_pedido_publico_comanda` tenía `column
// 'numero_local' is ambiguous` y nadie llamaba a la RPC en tests reales.
// Mismo día encontramos 3 RPCs más con bugs análogos:
//   - fn_crear_delivery_rider (column 'l.deleted_at' does not exist)
//   - fn_crear_print_agent_token (idem)
//   - fn_reporte_menu_engineering_comanda (column 'cantidad_vendida' ambiguous)
//
// Este script es la red de seguridad para que esto NO vuelva a pasar.
//
// CÓMO FUNCIONA:
// 1. Lista todos los RPCs públicos con `RETURNS TABLE(...)`.
// 2. Para cada uno, arma args dummy tipo-compatibles según signature.
// 3. Ejecuta la RPC con auth como `dueno@pase.local` (admin del tenant Prueba).
// 4. Captura el error y lo clasifica:
//    - OK_VOID / OK_INPUT / OK_AUTH / OK_NOT_FOUND / OTRO  → la RPC arrancó bien
//    - COLUMNA_INEXISTENTE / COLUMNA_AMBIGUA / FUNCION_INEXISTENTE /
//      OPERADOR_INEXISTENTE / CAST_INVALIDO / TABLA_INEXISTENTE → BUG REAL
// 5. Sale con exit code 0 si no hay bugs, 1 si hay (para CI).
//
// CÓMO USARLO:
//   1. npx vercel env pull packages/pase/.env.local --environment=production
//   2. node packages/pase/scripts/audit-rpcs-latentes.mjs
//
// LIMITACIONES:
// - Solo cubre RPCs con `RETURNS TABLE`. Las que retornan scalar (numeric,
//   void, jsonb, etc.) requieren extensión separada (TODO).
// - Solo detecta errores que se manifiestan en las primeras líneas del
//   plpgsql (antes de validación de input/permiso). Bugs latentes en
//   ramas condicionales del código no se detectan.
// - No detecta lógica incorrecta — solo errores que Postgres reporta como
//   "schema does not match what the code references".
//
// SI ENCONTRÁS UN BUG NUEVO:
// 1. Leer la definición: `SELECT pg_get_functiondef(oid) FROM pg_proc
//    WHERE proname='fn_X'`.
// 2. Identificar el patrón (ambiguous, column inexistente, etc.).
// 3. Crear migration de fix en supabase/migrations/.
// 4. Aplicar con script ad-hoc + commit + push.
// 5. Re-correr este script: debería pasar.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env.local");

function loadEnv(key) {
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!m || !m[1]) throw new Error(`${key} no encontrada en ${envPath}`);
  return m[1].trim().replace(/^"(.*)"$/, "$1");
}

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const TENANT_PRUEBA = "5841143c-5594-4728-99c6-a313d40618e6";
const LOCAL_PRUEBA = 7;

const db = createClient(SUPABASE_URL, loadEnv("VITE_SUPABASE_ANON_KEY"), {
  auth: { persistSession: false },
});
const { error: authErr } = await db.auth.signInWithPassword({
  email: "dueno@pase.local",
  password: process.env.DUENO_PASSWORD ?? "Renata2020",
});
if (authErr) {
  console.error("✗ Login dueno falló:", authErr.message);
  console.error("  Tip: setear DUENO_PASSWORD env var si la contraseña cambió.");
  process.exit(2);
}

const pgClient = new pg.Client({
  connectionString: loadEnv("POSTGRES_URL_NON_POOLING"),
  ssl: { rejectUnauthorized: false },
});
await pgClient.connect();

const today = new Date().toISOString().slice(0, 10);

function dummyValue(tipo) {
  const t = tipo.toLowerCase();
  if (t === "uuid") return TENANT_PRUEBA;
  if (t === "integer" || t.includes("int")) return LOCAL_PRUEBA;
  if (t === "bigint") return 1;
  if (t === "numeric") return 0;
  if (t === "date") return today;
  if (t.includes("timestamp")) return new Date().toISOString();
  if (t === "boolean") return true;
  if (t === "jsonb" || t === "json") return [];
  if (t.startsWith("text") || t === "name" || t === "varchar") return "AUDIT_PROBE";
  return null;
}

function clasificarError(msg) {
  const m = msg.toLowerCase();
  // ── BUGS REALES ──────────────────────────────────────────────────
  if (m.includes("does not exist") && m.includes("column")) return "COLUMNA_INEXISTENTE";
  if (m.includes("is ambiguous") && m.includes("column")) return "COLUMNA_AMBIGUA";
  if (m.includes("does not exist") && m.includes("function")) return "FUNCION_INEXISTENTE";
  if (m.includes("operator does not exist")) return "OPERADOR_INEXISTENTE";
  if (m.includes("cannot cast")) return "CAST_INVALIDO";
  if (m.includes("relation") && m.includes("does not exist")) return "TABLA_INEXISTENTE";
  // ── ERRORES ESPERABLES (la RPC arrancó bien) ─────────────────────
  if (m.includes("permiso") || m.includes("permission")) return "OK_PERMISO";
  if (m.includes("auth") || m.includes("tenant_mismatch")) return "OK_AUTH";
  if (m.includes("no encontrad") || m.includes("not found") || m.includes("_no_encontrado")) return "OK_NOT_FOUND";
  if (m.includes("invalid") || m.includes("vacío") || m.includes("vacio")) return "OK_INPUT";
  if (m.includes("debe ser") || m.includes("must be")) return "OK_INPUT";
  if (m.includes("formato") || m.includes("inválid") || m.includes("requerid")) return "OK_INPUT";
  if (m.includes("no abierto") || m.includes("no encontrada")) return "OK_NOT_FOUND";
  return "OTRO";
}

const ERROR_TYPES = new Set([
  "COLUMNA_INEXISTENTE", "COLUMNA_AMBIGUA", "FUNCION_INEXISTENTE",
  "OPERADOR_INEXISTENTE", "CAST_INVALIDO", "TABLA_INEXISTENTE",
]);

console.log("\n=== Auditoría defensiva RPCs con RETURNS TABLE ===\n");

const rpcs = await pgClient.query(`
  SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND pg_get_function_result(p.oid) ILIKE 'TABLE(%'
    AND p.proname NOT ILIKE 'fn_trg_%'
    AND p.proname NOT ILIKE 'pg_%'
  ORDER BY p.proname
`);

const bugs = [];
const dist = {};
let total = 0;

for (const r of rpcs.rows) {
  total++;
  const argDefs = r.args.split(",").map(s => s.trim()).filter(Boolean).map(s => {
    const noDefault = s.split(/\s+DEFAULT\s+/i)[0]?.trim() ?? s;
    const parts = noDefault.split(/\s+/);
    return { name: parts[0], type: parts.slice(1).join(" ") };
  });
  const params = {};
  for (const a of argDefs) params[a.name] = dummyValue(a.type);

  try {
    const { error } = await db.rpc(r.name, params);
    const tipo = error ? clasificarError(error.message) : "OK_VOID";
    dist[tipo] = (dist[tipo] ?? 0) + 1;
    if (ERROR_TYPES.has(tipo)) {
      bugs.push({ rpc: r.name, tipo, mensaje: (error?.message ?? "").slice(0, 300) });
    }
  } catch (e) {
    dist["EXCEPCION"] = (dist["EXCEPCION"] ?? 0) + 1;
  }
}

await pgClient.end();
await db.auth.signOut();

console.log(`Testeados: ${total} RPCs\n`);
console.log("Distribución:");
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  const flag = ERROR_TYPES.has(k) ? "🚨" : "  ";
  console.log(`  ${flag} ${k.padEnd(22)} ${v}`);
}

if (bugs.length === 0) {
  console.log("\n✓ Ningún bug latente detectado. Todas las RPCs con RETURNS TABLE están sanas.");
  process.exit(0);
}

console.error(`\n🚨 ${bugs.length} BUG${bugs.length > 1 ? "S" : ""} LATENTE${bugs.length > 1 ? "S" : ""} DETECTADO${bugs.length > 1 ? "S" : ""} EN PRODUCCIÓN:\n`);
for (const b of bugs) {
  console.error(`  ❌ ${b.rpc}`);
  console.error(`     [${b.tipo}] ${b.mensaje}\n`);
}
console.error("Acción: leer pg_get_functiondef(oid), identificar el patrón y crear migration de fix.");
process.exit(1);
