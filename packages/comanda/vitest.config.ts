import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Config separada de vite.config.ts para que tsc -b no falle con el
// campo `test` (que no es parte del UserConfig de vite). Mirror del
// alias '@' definido en vite.config.ts para que tests puedan importar
// componentes con paths absolutos.
//
// Sprint 8 tarea 5: coverage v8 (built-in, no requiere extra dep) con
// thresholds bajos. Subir gradualmente sprint a sprint.
//   pnpm test --coverage  → reporte text + HTML en coverage/
//   pnpm test             → tests sin coverage (más rápido)
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/services/**', 'src/lib/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/types/**',
        '**/node_modules/**',
      ],
      // Thresholds reflejan la realidad actual post-sprint 8: ~25% en
      // services + lib. La auditoría 2026-05-07 lo había marcado como
      // 25% por archivo. Sprint 8 subió de 88 a 173 tests pero el code
      // base también creció. Subir gradualmente:
      //   Sprint 9: 35%
      //   Sprint 10: 45%
      //   Pre-launch SaaS: 60%
      thresholds: {
        lines: 25,
        functions: 25,
        branches: 25,
        statements: 25,
      },
    },
  },
});
