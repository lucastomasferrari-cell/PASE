import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Web propia del bot de Instagram (login + consola de mensajería). Convive con
// las Vercel Functions de api/ en el mismo proyecto (pase-instagram-bot).
// Los tests del backend usan vitest.config.js aparte.
// (rebuild trigger 27-jun: deploy de nombres de cliente.)
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(dirname, './src') },
  },
});
