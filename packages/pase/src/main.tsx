import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/tokens.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installChunkLoadErrorHandler } from './lib/chunkLoadErrorHandler'

// Detectar "Failed to fetch dynamically imported module" después de un
// deploy nuevo de Vercel → auto-reload (anti-loop con cooldown 60s).
// Sin esto, el user veía pantalla de error y tenía que recargar manual.
installChunkLoadErrorHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
