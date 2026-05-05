import type { ReactNode } from 'react';
import { Navigate, Outlet, useNavigate, Link } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { db } from '../lib/supabase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/lib/utils';

interface Props {
  children?: ReactNode;
}

// Gate de rutas autenticadas (catálogo / settings sin PIN POS).
// Redirige a /login si no hay sesión Supabase. Si hay sesión, renderiza
// header global consistente con PosLayout y el contenido (children u Outlet).
export function ProtectedShell({ children }: Props) {
  const { user, loading, error } = useAuth();
  const navigate = useNavigate();

  if (loading) return <CenteredMsg>Cargando…</CenteredMsg>;
  if (error) return <CenteredMsg variant="error">Error de sesión: {error}</CenteredMsg>;
  if (!user) return <Navigate to="/login" replace />;

  async function logout() {
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card sticky top-0 z-10">
        <div className="px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-lg font-bold tracking-tight">
              COMANDA
            </Link>
            {user.email && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-sm text-muted-foreground" title={`${user.nombre} · ${user.rol}`}>
                  {user.email}
                </span>
                <Badge variant="secondary" className="text-xs">
                  {user.rol}
                </Badge>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button variant="outline" size="icon" onClick={logout} title="Cerrar sesión">
              <LogOut className="h-4 w-4" />
              <span className="sr-only">Cerrar sesión</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children ?? <Outlet />}</main>
    </div>
  );
}

function CenteredMsg({ children, variant }: { children: ReactNode; variant?: 'error' }) {
  return (
    <div
      className={cn(
        'min-h-screen flex items-center justify-center p-6 text-center',
        variant === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}
