import { defineConfig } from 'vitest/config';

// Config separada de vite.config.ts para que tsc -b no falle con el
// campo `test` (que no es parte del UserConfig de vite). Se usa cuando
// agreguemos tests reales en comanda.
export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['node_modules/**'],
  },
});
