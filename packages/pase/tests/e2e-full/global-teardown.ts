// global-teardown.ts — corre UNA vez después de toda la suite E2E full.
//
// Elimina el tenant E2E + descarta el JSON del seed compartido.
// Idempotente: si ya no existe el tenant, no falla.

import type { FullConfig } from "@playwright/test";
import { cleanupE2ETenant } from "./setup/seed-tenant";
import { clearSharedSeed } from "./setup/shared-seed";

export default async function globalTeardown(config: FullConfig): Promise<void> {
  // Skip si no se corrió el project e2e-full (no hay nada que limpiar).
  const haceFalta = config.projects.some((p) => p.name === "e2e-full");
  if (!haceFalta) return;

  console.log("[globalTeardown] ── E2E full suite — cleanup final ──");
  const t0 = Date.now();

  // E2E_FORCE_CLEANUP=true desactiva el guard de cleanupE2ETenant que
  // normalmente lo hace NO-OP cuando hay shared-seed activo. Acá SÍ
  // queremos borrar el tenant compartido al final de la suite.
  process.env.E2E_FORCE_CLEANUP = "true";
  try {
    await cleanupE2ETenant();
  } catch (e) {
    // No tirar excepción aunque falle — la suite ya terminó, lo peor que
    // pasa es que el próximo run encuentre residuos y los limpie con su
    // propio globalSetup defensivo.
    console.warn("[globalTeardown] cleanupE2ETenant falló:", (e as Error).message);
  }
  delete process.env.E2E_FORCE_CLEANUP;

  clearSharedSeed();

  console.log(`[globalTeardown] ✓ Cleanup completo en ${Date.now() - t0}ms`);
}
