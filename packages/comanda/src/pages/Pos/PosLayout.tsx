import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { ArrowLeft, Wallet, Search, BarChart3 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { usePermiso } from '@/lib/usePermiso';
import { getTurnoAbierto } from '@/services/turnosCajaService';
import type { TurnoCaja } from '@/types/database';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PosSidebar } from '@/components/PosSidebar';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { AllChecksModal } from '@/components/AllChecksModal';

// Layout principal POS: header sticky con marca + turno + acciones,
// sidebar permanente de 72px (Salón/Mostrador/Pedidos), contenido en
// <Outlet />. Reemplaza el layout viejo con íconos sueltos en el header.
export function PosLayout() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const puedeAdmin = usePermiso('comanda.config.editar');
  const puedeReportes = usePermiso('comanda.reportes.ver');
  const [allChecksOpen, setAllChecksOpen] = useState(false);

  useEffect(() => {
    if (localId === null) return;
    let cancelled = false;
    function refetch() {
      if (localId === null) return;
      getTurnoAbierto(localId).then((res) => {
        if (!cancelled) setTurno(res.data);
      });
    }
    refetch();
    // CajaAbrir y CajaCerrar disparan este evento en éxito. PosLayout
    // queda montado en /caja/* (router nesting) por lo que el efecto de
    // mount no se vuelve a ejecutar al volver al POS — usar un evento
    // global es más liviano que un context y no requiere refactor.
    window.addEventListener('comanda:turno-changed', refetch);
    return () => {
      cancelled = true;
      window.removeEventListener('comanda:turno-changed', refetch);
    };
  }, [localId]);

  // Atajo: tecla "/" abre el modal de todas las cuentas (no en inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      setAllChecksOpen(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const minutosTurno = turno
    ? Math.max(0, Math.floor((Date.now() - new Date(turno.abierto_at).getTime()) / 60_000))
    : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-10 flex-shrink-0">
        <div className="px-5 py-3 flex items-center justify-between gap-3 h-14">
          {/* Izquierda: marca + turno */}
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/" className="text-lg font-medium tracking-wide text-primary flex-shrink-0">
              COMANDA
            </Link>
            {turno && (
              <>
                <span className="text-muted-foreground hidden md:inline">·</span>
                <Link
                  to="/caja"
                  className="hidden md:flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors min-w-0"
                >
                  <span className="relative flex h-2 w-2 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
                  </span>
                  <span className="truncate">
                    Turno #{turno.numero} · abierto hace {minutosTurno} min
                  </span>
                </Link>
              </>
            )}
            {!turno && (
              <>
                <span className="text-muted-foreground hidden md:inline">·</span>
                <Link
                  to="/caja"
                  className="hidden md:flex items-center gap-2 text-sm text-destructive font-medium hover:opacity-80 transition-opacity"
                >
                  <span className="h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                  Sin turno abierto
                </Link>
              </>
            )}
          </div>

          {/* Derecha: acciones */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAllChecksOpen(true)}
              title="Buscar cuentas (atajo: /)"
            >
              <Search className="h-4 w-4" />
              <span className="sr-only">Buscar cuentas</span>
            </Button>

            <ThemeToggle />

            <Button variant="outline" asChild>
              <Link to="/caja" className="flex items-center gap-2">
                <Wallet className="h-4 w-4" />
                <span className="hidden sm:inline">Caja</span>
              </Link>
            </Button>

            <UserAvatarMenu />

            {puedeReportes && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/reportes" className="flex items-center gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reportes</span>
                </Link>
              </Button>
            )}

            {puedeAdmin && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/catalogo" className="flex items-center gap-1.5">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Admin
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <AllChecksModal open={allChecksOpen} onOpenChange={setAllChecksOpen} />

      {/* Body: sidebar + content */}
      <div className="flex-1 flex min-h-0">
        <PosSidebar />
        <main className="flex-1 min-w-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
