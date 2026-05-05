import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// Inverso de ProtectedShell: si ya hay sesión, redirige a /catalogo.
// Se usa para envolver /login: previene mostrar el form a usuarios ya logueados.
export function RedirectIfAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 text-sm text-muted-foreground bg-background">
        Cargando…
      </div>
    );
  }
  if (user) {
    return <Navigate to="/catalogo" replace />;
  }
  return <>{children}</>;
}
