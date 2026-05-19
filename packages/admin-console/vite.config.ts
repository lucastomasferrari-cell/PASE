import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    // PWA: instalable como app en celu/tablet. Lucas la usa desde el celu
    // para revisar y aprobar PRs del auto-fix sin abrir la compu.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PASE Admin Console',
        short_name: 'PASE Admin',
        description: 'Panel de administración del sistema PASE+COMANDA — soporte, tenants, billing, métricas.',
        theme_color: '#1A2027',
        background_color: '#0F1419',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/soporte',
        scope: '/',
        lang: 'es-AR',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // No cachear requests a Supabase (datos vivos — no quiero servir
        // tickets stale al superadmin). Solo cachear shell + assets.
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
  server: { port: 5175 },
});
