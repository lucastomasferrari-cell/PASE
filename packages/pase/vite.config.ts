import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Build version: hash corto del commit actual. Se embebe en el bundle
// (vía `define`) y se escribe en `dist/version.json`. La app fetchea ese
// archivo con cache-bust cada 5 min + on focus; si la versión del server
// no coincide con la embebida → signOut + reload (fuerza JWT/bundle frescos
// tras cada deploy). Pedido Lucas 31-may.
function getBuildVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return `dev-${Date.now()}`;
  }
}
const BUILD_VERSION = getBuildVersion();
const BUILT_AT = new Date().toISOString();

function writeVersionJson(): Plugin {
  return {
    name: 'write-version-json',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(process.cwd(), 'dist');
      try { mkdirSync(outDir, { recursive: true }); } catch { /* ya existe */ }
      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify({ version: BUILD_VERSION, builtAt: BUILT_AT }, null, 2),
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), writeVersionJson()],
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
    __BUILT_AT__: JSON.stringify(BUILT_AT),
  },
  build: {
    rollupOptions: {
      output: {
        // Manual chunks: separamos vendors pesados que cambian poco para
        // mejorar caching del browser. Un user que vuelve mañana no
        // re-baja React/Supabase si solo deployamos app code.
        manualChunks: (id: string) => {
          if (id.includes('node_modules/react-router') || id.includes('node_modules/react-dom') || /node_modules[\\/]react[\\/]/.test(id) || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@supabase')) {
            return 'vendor-supabase';
          }
          // Fix auditoría 2026-05-21 CRIT-12: recharts (~400KB) y driver.js
          // (~80KB) iban al chunk principal por no estar particionados.
          // Ahora bajan solo cuando se carga una pantalla que los usa.
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/driver.js')) {
            return 'vendor-onboarding';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    exclude: ["tests/**", "node_modules/**"],
  },
})
