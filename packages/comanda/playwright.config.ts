import { defineConfig } from '@playwright/test';

// COMANDA tests E2E mutantes (F1.4, 2026-05-15) + UI smoke (2026-06-04).
// Mismo patrón que packages/pase/playwright.config.ts:
// - smoke: tests UI no-mutantes en paralelo (incluyendo ui_*.spec.ts).
// - mutante: tests _mutante.spec.ts en serie (--workers=1) porque comparten
//   recursos seed (Local Prueba 2, sentinels en ventas_pos).
//
// baseURL apunta a la URL standalone de COMANDA (pase-comanda.vercel.app),
// no a PASE. Tests UI navegan ahí.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'https://pase-comanda.vercel.app',
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
