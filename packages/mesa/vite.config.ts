import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MESA — tercer producto del ecosistema (reservas). Deploy Vercel propio.
// __dirname no existe en ESM — se deriva del import.meta.url.
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // PWA — hace MESA instalable en la tablet/celu del equipo (mismo patrón
    // que COMANDA). autoUpdate: el SW nuevo toma control solo; el panel de
    // reservas no tiene un "carrito" que perder con un refresh, así que no
    // hace falta el prompt de actualización que sí usa COMANDA.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'MESA — Reservas',
        short_name: 'MESA',
        description: 'Reservas, plano del salón y lista de espera.',
        theme_color: '#75AADB',
        background_color: '#EFF3F8',
        display: 'standalone',
        orientation: 'any',
        // El ícono instalado es la app del equipo → arranca en el panel.
        start_url: '/admin',
        scope: '/',
        lang: 'es-AR',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // NetworkFirst para navegación: si hay internet trae HTML fresco (clave
        // para que la disponibilidad de reservas nunca quede vieja). Las /api
        // y Supabase NUNCA se cachean.
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
