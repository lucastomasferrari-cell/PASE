import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// `base` se setea via env var VITE_BASE_PATH cuando se buildea embebido en
// PASE (script scripts/build-comanda-into-pase.mjs). En dev queda "/".
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: { port: 5174 },
});
