import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// Si ya hay sesión, redirige al admin (sprint 6: /reportes/dashboard,
// la ruta admin con el permiso más bajo). Se usa para envolver /login:
// previene mostrar el form a usuarios ya logueados.
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
    return <Navigate to="/reportes/dashboard" replace />;
  }
  return <>{children}</>;
}
