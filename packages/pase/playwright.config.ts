import { defineConfig } from "@playwright/test";

// Tres projects:
// - smoke: tests no-mutantes, paralelo (workers default).
// - mutante: tests con sufijo _mutante.spec.ts, deben correr en serie
//   (--workers=1 vía script) porque comparten recursos seed
//   (Proveedor Prueba, saldos_caja Caja Efectivo en Local Prueba 2).
// - e2e-full: suite punta-a-punta del "mes operativo" contra tenant
//   aislado "E2E Test Suite". Corre serial (los tests dependen del
//   estado del anterior) y con timeout largo (las 70 operaciones tardan).
//   Si querés correr solo esta suite: `pnpm test:e2e:full`.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "https://pase-yndx.vercel.app",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testIgnore: [/_mutante\.spec\.ts$/, /e2e-full\//],
      use: { browserName: "chromium" },
    },
    {
      name: "mutante",
      testMatch: /_mutante\.spec\.ts$/,
      testIgnore: /e2e-full\//,
      use: { browserName: "chromium" },
    },
    {
      name: "e2e-full",
      testDir: "./tests/e2e-full",
      // Timeout 5 min por test (los del mes operativo pueden tardar bastante)
      timeout: 5 * 60_000,
      // Serial: los tests dependen del estado del seed previo
      fullyParallel: false,
      workers: 1,
      use: { browserName: "chromium" },
    },
  ],
  reporter: [["html", { open: "never" }]],
  outputDir: "./screenshots",
});
