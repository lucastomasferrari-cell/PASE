import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// `base` queda fijo en "/" desde el cleanup 22-may noche (COMANDA pasó a
// URL propia, ya no se buildea con base="/comanda-app/"). Mantengo la env
// var por si en el futuro se reintroduce el embed o se sirve bajo sub-path.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
    react(),
    // PWA: hace COMANDA instalable como app en tablet/celu. Manifest
    // standalone = abre sin barras del navegador. Service worker offline
    // mínimo: precachea el shell + assets, fallback offline.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'COMANDA',
        short_name: 'COMANDA',
        description: 'POS para mozos y cajeros — comandar, cobrar, KDS',
        theme_color: '#5A8FA8',
        background_color: '#5A8FA8',
        display: 'standalone',
        orientation: 'any',
        start_url: '/pos',
        scope: '/',
        lang: 'es-AR',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Cachear shell + assets de la app. Excluir requests a Supabase
        // (datos vivos, no quiero servir stale al mozo).
        navigateFallbackDenylist: [/^\/api\//, /\.supabase\.co/],
        runtimeCaching: [
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  server: { port: 5174 },
});
