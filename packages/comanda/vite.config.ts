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
      // Estrategia post 24-may noche: 'prompt' en vez de 'autoUpdate' porque
      // autoUpdate dejaba el SW nuevo en estado "waiting" hasta que se
      // cerraran TODAS las tabs — sin tabs cerradas, los empleados seguían
      // viendo la versión vieja durante semanas (incidente Lucas reportó
      // que el login de COMANDA seguía pidiendo @ después del fix).
      // 'prompt' habilita el hook useRegisterSW que disparamos desde
      // <PWAUpdatePrompt /> con un toast no-disruptivo ("hay versión nueva,
      // actualizar"). El usuario decide cuándo recargar — clave en COMANDA
      // donde un mozo puede estar a mitad de cobrar y un auto-reload le
      // borraría el carrito.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'COMANDA',
        short_name: 'COMANDA',
        description: 'POS para mozos y cajeros — comandar, cobrar, KDS',
        // theme_color: color de la barra de status del navegador cuando la
        // PWA está corriendo standalone. Navy oscuro alineado con la Welcome
        // (fondo terminal-style de la app instalada).
        theme_color: '#0A0E17',
        // background_color: se muestra en el splash screen al abrir la app
        // instalada, antes de que React monte. Mismo navy que la Welcome →
        // el splash se ve continuo con la primera pantalla que carga.
        background_color: '#0A0E17',
        display: 'standalone',
        orientation: 'any',
        // start_url raíz: al abrir el ícono instalado, arranca en la
        // Welcome (selector Admin/POS). Si ya hay sesión, un click va
        // directo (RedirectIfAuth respeta ?next=).
        start_url: '/',
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
        // clientsClaim + skipWaiting: el SW nuevo toma control INMEDIATO
        // de las pestañas existentes (no espera a que el user cierre todo).
        // Combinado con registerType:'prompt', el flow es:
        //   1) browser baja SW nuevo en background
        //   2) <PWAUpdatePrompt /> muestra toast "actualizar"
        //   3) user click → skipWaiting → recarga la SPA con la versión nueva
        clientsClaim: true,
        skipWaiting: true,
        // NetworkFirst para navegación (HTML): si hay internet, siempre
        // trae fresco. Si cae, cae al cache (offline funciona). Antes era
        // CacheFirst implícito (default workbox), que servía HTML stale.
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
          {
            // HTML del navigate (cuando el user va a otra ruta): siempre
            // pegar a network primero. Si timeout 3s o falla, usar cache.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
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
    // AUDIT F3B#3: era 1000 — ocultaba que el index.js tenía 765 KB monolítico.
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // AUDIT F3B#1: el index.js de COMANDA tenía 765 KB monolítico (sin
        // vendor splitting). PASE prueba que el patrón function funciona:
        // con 4 buckets baja el inicial a 117 KB. Replicamos acá.
        manualChunks: (id: string) => {
          if (id.includes('node_modules/react-router') ||
              id.includes('node_modules/react-dom') ||
              /node_modules[\\/]react[\\/]/.test(id) ||
              id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@supabase')) {
            return 'vendor-supabase';
          }
          if (id.includes('node_modules/@radix-ui')) {
            return 'vendor-radix';
          }
          if (id.includes('node_modules/workbox-')) {
            return 'vendor-pwa';
          }
          if (id.includes('node_modules/idb')) {
            return 'vendor-idb';
          }
          return undefined;
        },
      },
    },
  },
  server: { port: 5174 },
});
