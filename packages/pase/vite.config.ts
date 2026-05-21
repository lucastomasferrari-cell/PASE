import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
