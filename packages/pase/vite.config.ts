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
          return undefined;
        },
      },
    },
  },
  test: {
    exclude: ["tests/**", "node_modules/**"],
  },
})
