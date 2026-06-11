import '@/styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { db } from './lib/supabase';
import { installChunkLoadErrorHandler } from './lib/chunkLoadErrorHandler';

// Detectar "Failed to fetch dynamically imported module" después de un
// deploy nuevo de Vercel → auto-reload (anti-loop con cooldown 60s).
// Cubre imports dinámicos fuera del render de React (services, click
// handlers) donde el ErrorBoundary no llega. Bug "Abrir mesa" 11-jun.
installChunkLoadErrorHandler();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No root element');

// SSO bridge desde PASE: si la URL tiene ?at=...&rt=... (access_token + refresh_token),
// los aplicamos como sesión y limpiamos los params del history.
// Es la forma que tiene PASE de pasar el login al COMANDA cuando viven
// en dominios distintos (Supabase Auth no comparte cookie cross-domain).
// Decidido 21-may noche al separar COMANDA a URL propia.
(async () => {
  const params = new URLSearchParams(window.location.search);
  const at = params.get('at');
  const rt = params.get('rt');
  if (at && rt) {
    try {
      await db.auth.setSession({ access_token: at, refresh_token: rt });
    } catch (e) {
      console.warn('[sso] setSession falló:', e);
    }
    // Limpiar params para que no queden en el history.
    params.delete('at');
    params.delete('rt');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
