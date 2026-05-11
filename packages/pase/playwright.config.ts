import { defineConfig } from "@playwright/test";

// Dos projects:
// - smoke: tests no-mutantes, paralelo (workers default).
// - mutante: tests con sufijo _mutante.spec.ts, deben correr en serie
//   (--workers=1 vía script) porque comparten recursos seed
//   (Proveedor Prueba, saldos_caja Caja Efectivo en Local Prueba 2).
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
      testIgnore: /_mutante\.spec\.ts$/,
      use: { browserName: "chromium" },
    },
    {
      name: "mutante",
      testMatch: /_mutante\.spec\.ts$/,
      use: { browserName: "chromium" },
    },
  ],
  reporter: [["html", { open: "never" }]],
  outputDir: "./screenshots",
});
