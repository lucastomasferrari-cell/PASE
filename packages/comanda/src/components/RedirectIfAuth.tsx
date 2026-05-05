import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// Inverso de ProtectedShell: si ya hay sesión, redirige a /catalogo.
// Se usa para envolver /login: previene mostrar el form a usuarios ya logueados.
export function RedirectIfAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#6B7280',
          fontSize: 14,
        }}
      >
        Cargando…
      </div>
    );
  }
  if (user) {
    return <Navigate to="/catalogo" replace />;
  }
  return <>{children}</>;
}
