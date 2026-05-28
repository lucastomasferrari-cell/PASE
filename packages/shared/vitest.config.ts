// Config mínima para que vitest no busque un vite.config.ts hacia arriba
// del árbol de archivos (que en esta máquina termina en una ruta inexistente).
//
// @pase/shared no tiene tests propios todavía (los tests viven en los
// paquetes consumidores), pero CI corre `vitest run --passWithNoTests`
// para que el paquete esté en la pipeline de tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
