import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/AuthProvider';
import { ProtectedShell } from './components/ProtectedShell';
import { RedirectIfAuth } from './components/RedirectIfAuth';
import { CatalogoLayout } from './pages/Catalogo/CatalogoLayout';
import { LoginPage } from './pages/Login/LoginPage';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuth>
                <LoginPage />
              </RedirectIfAuth>
            }
          />
          <Route
            path="/catalogo"
            element={
              <ProtectedShell>
                <CatalogoLayout />
              </ProtectedShell>
            }
          />
          <Route path="*" element={<Navigate to="/catalogo" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
