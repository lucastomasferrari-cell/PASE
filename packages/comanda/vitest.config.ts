import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Config separada de vite.config.ts para que tsc -b no falle con el
// campo `test` (que no es parte del UserConfig de vite). Mirror del
// alias '@' definido en vite.config.ts para que tests puedan importar
// componentes con paths absolutos.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['node_modules/**'],
  },
});
