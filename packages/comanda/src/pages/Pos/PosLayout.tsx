import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { Lock, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { getTurnoAbierto } from '@/services/turnosCajaService';
import type { TurnoCaja } from '@/types/database';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';

interface Props { children?: ReactNode }

export function PosLayout({ children }: Props) {
  const { user } = useAuth();
  const { empleado, logout: logoutPos } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (localId !== null) {
      getTurnoAbierto(localId).then((res) => setTurno(res.data));
    }
  }, [localId]);

  async function fullLogout() {
    logoutPos();
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  const esManager = empleado?.rol_pos === 'manager' || empleado?.rol_pos === 'dueno';
  const minutosTurno = turno
    ? Math.max(0, Math.floor((Date.now() - new Date(turno.abierto_at).getTime()) / 60_000))
    : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card sticky top-0 z-10">
        <div className="px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Link to="/pos" className="text-lg font-bold tracking-tight">
              COMANDA
            </Link>
            <span className="text-muted-foreground">·</span>
            <Link to="/caja" className="flex items-center gap-2">
              {turno ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Turno #{turno.numero} · abierto hace {minutosTurno} min
                  </span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-destructive" />
                  <span className="text-sm text-destructive font-medium">
                    Sin turno abierto
                  </span>
                </>
              )}
            </Link>
          </div>

          <div className="flex items-center gap-3">
            {empleado && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{empleado.nombre}</span>
                <Badge variant="secondary" className="text-xs">
                  {empleado.rol_pos}
                </Badge>
              </div>
            )}
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Button variant="outline" size="icon" onClick={logoutPos} title="Bloquear (cambiar empleado)">
                <Lock className="h-4 w-4" />
                <span className="sr-only">Bloquear</span>
              </Button>
              {esManager && (
                <Button variant="outline" size="icon" asChild title="Settings">
                  <Link to="/settings">
                    <SettingsIcon className="h-4 w-4" />
                    <span className="sr-only">Settings</span>
                  </Link>
                </Button>
              )}
              <Button variant="outline" size="icon" onClick={fullLogout} title="Cerrar sesión">
                <LogOut className="h-4 w-4" />
                <span className="sr-only">Cerrar sesión</span>
              </Button>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1">{children ?? <Outlet />}</main>
    </div>
  );
}
