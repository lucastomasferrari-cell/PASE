import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/tokens.css'
import './styles/v2-tokens.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installChunkLoadErrorHandler } from './lib/chunkLoadErrorHandler'

// Detectar "Failed to fetch dynamically imported module" después de un
// deploy nuevo de Vercel → auto-reload (anti-loop con cooldown 60s).
// Sin esto, el user veía pantalla de error y tenía que recargar manual.
installChunkLoadErrorHandler();

// Registrar service worker (push notifications + PWA install).
// Solo en producción/preview — en localhost el SW interfiere con HMR de Vite.
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registro falló:', err);
    });
  });

  // Cuando el SW manda postMessage type:'navigate' (al click en notif),
  // navegamos a la URL pedida.
  //
  // Bug 27-may noche (Lucas: "las notificaciones no abren bien abre cualquier
  // cosa"): el approach viejo era `history.pushState + popstate sintético`
  // para hacer SPA navigation sin recargar. Pero React Router NO siempre
  // escucha el popstate sintético → la URL del browser cambiaba pero la
  // pantalla quedaba en la ruta anterior. Usuario veía "cualquier cosa".
  //
  // Fix: window.location.assign garantiza navegación real (con recarga).
  // Trade-off aceptable porque viene de una notif push (no navegación
  // cotidiana donde la recarga molestaría).
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate' && event.data?.url) {
      window.location.assign(event.data.url);
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
