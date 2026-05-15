import { defineConfig } from '@playwright/test';

// COMANDA tests E2E mutantes (F1.4, 2026-05-15).
// Mismo patrón que packages/pase/playwright.config.ts:
// - smoke: tests no-mutantes en paralelo (futuro).
// - mutante: tests _mutante.spec.ts en serie (--workers=1) porque comparten
//   recursos seed (Local Prueba 2, sentinels en ventas_pos).
//
// DB-only por ahora: COMANDA no tiene smoke UI todavía (deuda). Los tests
// pegan directo a Supabase con sesión dueño Neko. No navegan UI.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'https://pase-yndx.vercel.app',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'smoke',
      testIgnore: /_mutante\.spec\.ts$/,
      use: { browserName: 'chromium' },
    },
    {
      name: 'mutante',
      testMatch: /_mutante\.spec\.ts$/,
      use: { browserName: 'chromium' },
    },
  ],
  reporter: [['html', { open: 'never' }]],
  outputDir: './screenshots',
});
