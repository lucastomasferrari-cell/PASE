// global-setup.ts — corre UNA vez antes de toda la suite E2E full.
//
// Hace cleanup defensivo + seed completo del tenant E2E. El resultado se
// persiste en /tmp/pase-e2e-shared-seed.json para que los tests lo lean
// con `loadSharedSeed()`.
//
// Por qué este patrón (no que cada test haga su seed):
//   - Eliminaba la cascada de SLUG_DUPLICATED cuando el cleanup async
//     no terminaba antes del siguiente seed.
//   - Eliminaba el rate-limit de Supabase Auth (~30 logins/min) que
//     caía a los últimos tests de la suite.
//
// Como vive a nivel root del playwright.config (Playwright 1.59 no
// soporta globalSetup por project), chequea explícitamente si el run
// incluye el project "e2e-full" — si no, NO hace nada (los runs de
// smoke/mutante no necesitan tenant E2E).
//
// Si globalSetup falla, Playwright skipea toda la suite con error claro.

import type { FullConfig } from "@playwright/test";
import { createSuperadminClient } from "../helpers/supabaseClient";
import { cleanupE2ETenant, seedE2ETenant } from "./setup/seed-tenant";
import { saveSharedSeed } from "./setup/shared-seed";

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Skip si no se va a correr el project e2e-full.
  // Playwright filtra `config.projects` según --project en la CLI.
  const haceFalta = config.projects.some((p) => p.name === "e2e-full");
  if (!haceFalta) {
    return;
  }

  console.log("[globalSetup] ── E2E full suite — preparando tenant compartido ──");
  const t0 = Date.now();

  // 1) Cleanup idempotente del tenant E2E previo (si quedó residuo de
  //    una corrida anterior). NO falla si no existe.
  console.log("[globalSetup] 1/3 cleanup defensivo del tenant E2E previo…");
  try {
    await cleanupE2ETenant();
  } catch (e) {
    console.warn("[globalSetup] cleanup defensivo tiró:", (e as Error).message);
  }

  // 2) Login como superadmin (UNA sola vez por toda la suite).
  console.log("[globalSetup] 2/3 login superadmin…");
  const superdb = await createSuperadminClient();
  if (!superdb) {
    throw new Error(
      "[globalSetup] SUPERADMIN_PASSWORD no seteado en packages/pase/.env.local.\n" +
      "  Agregalo con: npx vercel env pull .env.local --environment=production\n" +
      "  + tu password de superadmin.",
    );
  }
  const { data: sess } = await superdb.auth.getSession();
  const superToken = sess?.session?.access_token;
  if (!superToken) {
    throw new Error("[globalSetup] No se pudo obtener token superadmin");
  }

  // 3) Seed completo del tenant E2E.
  console.log("[globalSetup] 3/3 seed completo del tenant E2E…");
  const baseUrl = (process.env.E2E_BASE_URL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
  const seed = await seedE2ETenant({ superadminToken: superToken, baseUrl });

  // 4) Persistir el seed para que los tests lo lean.
  saveSharedSeed(seed);

  await superdb.auth.signOut();

  const ms = Date.now() - t0;
  console.log(`[globalSetup] ✓ Tenant E2E listo en ${ms}ms (slug=${seed.tenantId.slice(0,8)}…)`);
}
