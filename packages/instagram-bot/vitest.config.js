// Vitest config mínima para tests del bot de Instagram.
//
// El bot no usa Vite (deploy directo como Vercel Functions desde api/),
// así que necesitamos config explícita para que vitest sepa qué incluir
// y cómo resolver módulos.
//
// Tests cubren las pure-functions críticas de seguridad/billing:
//   - validarFirmaWebhook (HMAC SHA-256 anti-spoofing de Meta)
//   - rate limit logic (anti-spam → tope de costo Claude)
//   - upsert estado conversación (F6A#1 — no reactivar bot si humano tomó)
//
// Para tests con DB real / network, usar e2e separado (no vive acá).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['api/**/__tests__/**/*.test.{js,mjs}', 'api/**/*.test.{js,mjs}'],
    exclude: ['node_modules', 'dist'],
  },
});
