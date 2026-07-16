import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// Si ya hay sesión, redirige:
//   - a la ruta ?next= si viene seteada (el WelcomePage la usa para elegir
//     POS o Admin sin re-loguear)
//   - a /reportes/dashboard como default (ruta admin con el permiso más bajo)
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
    const next = new URLSearchParams(window.location.search).get('next');
    const target = next && next.startsWith('/') ? next : '/reportes/dashboard';
    return <Navigate to={target} replace />;
  }
  return <>{children}</>;
}
