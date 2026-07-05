import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MESA — tercer producto del ecosistema (reservas). Deploy Vercel propio.
// __dirname no existe en ESM — se deriva del import.meta.url.
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(dirname, './src') },
  },
  server: {
    // En prod, vercel.json reescribe /api/* → pase-yndx.vercel.app (ahí viven
    // los endpoints serverless). En dev replicamos eso con un proxy para que
    // el flujo de reserva pública funcione igual que en producción.
    proxy: {
      '/api': {
        target: 'https://pase-yndx.vercel.app',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
