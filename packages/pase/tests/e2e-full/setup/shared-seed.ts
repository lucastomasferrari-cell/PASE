// shared-seed.ts — helpers para que TODOS los tests E2E full compartan
// el mismo tenant E2E creado UNA vez por globalSetup.
//
// Por qué existe (sprint 27-may noche):
//   El patrón viejo era que cada test hiciera su propio cleanup + seed en
//   beforeAll. Eso causaba 2 problemas en CI:
//     1. Cascada de SLUG_DUPLICATED: cleanup async no terminaba antes
//        del siguiente seed → crear tenant fallaba por slug ya existente.
//     2. Rate limit de Supabase Auth (~30 logins/min) por loguearse como
//        superadmin en cada beforeAll. Los últimos tests caían con
//        "Request rate limit reached".
//
// Solución: global-setup.ts hace UN cleanup + UN seed al arranque y
// guarda el resultado en disco (JSON). Cada test lo lee con
// `loadSharedSeed()` en su beforeAll. global-teardown.ts hace el cleanup
// final cuando termina toda la suite.
//
// Convención: el path del JSON es el mismo en CI y local. NO se commitea.
// Si se ejecuta este módulo SIN globalSetup previo (ej. corriendo un test
// individual con .only), el seed NO existe y se hace seed on-demand.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2ETenantSeedResult } from "./seed-tenant";

const SEED_PATH = join(tmpdir(), "pase-e2e-shared-seed.json");

export function saveSharedSeed(seed: E2ETenantSeedResult): void {
  writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2), "utf-8");
}

/**
 * Lee el seed compartido del JSON. Throws si no existe — el globalSetup
 * de Playwright debe correr antes.
 */
export function loadSharedSeed(): E2ETenantSeedResult {
  if (!existsSync(SEED_PATH)) {
    throw new Error(
      "[shared-seed] No existe el JSON del seed compartido. " +
      "Asegurate de correr la suite con `pnpm test:e2e:full` (que dispara " +
      "globalSetup) y NO con `npx playwright test` directo. " +
      `Path esperado: ${SEED_PATH}`,
    );
  }
  try {
    const raw = readFileSync(SEED_PATH, "utf-8");
    return JSON.parse(raw) as E2ETenantSeedResult;
  } catch (e) {
    throw new Error(
      `[shared-seed] No se pudo parsear el seed JSON: ${(e as Error).message}`,
    );
  }
}

/**
 * Borra el JSON. Lo llama globalTeardown después del cleanup.
 */
export function clearSharedSeed(): void {
  try {
    if (existsSync(SEED_PATH)) {
      writeFileSync(SEED_PATH, "{}", "utf-8");
    }
  } catch {
    /* no-op */
  }
}

export const SHARED_SEED_PATH = SEED_PATH;
