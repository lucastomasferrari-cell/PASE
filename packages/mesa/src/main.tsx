import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { App } from './App';
import { capturarAtribucion } from './lib/atribucion';
import './styles/globals.css';

// Captura la fuente del visitante (pauta/IG/Google) en el primer toque.
capturarAtribucion();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <Toaster position="top-center" richColors />
    </BrowserRouter>
  </StrictMode>,
);
