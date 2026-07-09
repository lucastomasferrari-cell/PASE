import { useEffect, useState, useCallback } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Search, Smartphone, Maximize2, Minimize2, Moon, Sun } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { getTurnoAbierto } from '@/services/turnosCajaService';
import type { TurnoCaja } from '@/types/database';
import { Button } from '@/components/ui/button';
import { BusyModeButton } from '@/components/BusyModeButton';
import { PosSidebar } from '@/components/PosSidebar';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { AllChecksModal, type AllChecksInitialFilters } from '@/components/AllChecksModal';
import { MobileModoMozoBanner } from '@/components/MobileModoMozoBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { useTheme } from '@/hooks/useTheme';

// Layout principal POS: header sticky con marca + turno + acciones,
// sidebar permanente de 72px (Salón/Mostrador/Pedidos), contenido en
// <Outlet />. Reemplaza el layout viejo con íconos sueltos en el header.
export function PosLayout() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const [allChecksOpen, setAllChecksOpen] = useState(false);
  const [allChecksFilters, setAllChecksFilters] = useState<AllChecksInitialFilters | undefined>(undefined);

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
      setAllChecksFilters(undefined);
      setAllChecksOpen(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Otros views (SalonView, MostradorView) pueden abrir el modal con filtros
  // ya aplicados (p.ej. "cerradas del turno") disparando un CustomEvent.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<AllChecksInitialFilters>).detail;
      setAllChecksFilters(detail ?? undefined);
      setAllChecksOpen(true);
    }
    window.addEventListener('comanda:open-all-checks', onOpen);
    return () => window.removeEventListener('comanda:open-all-checks', onOpen);
  }, []);

  const { theme, toggleTheme } = useTheme();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  useEffect(() => {
    const doc = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    setFullscreenSupported(
      typeof document.fullscreenEnabled === 'boolean'
        ? document.fullscreenEnabled
        : Boolean(doc.webkitRequestFullscreen),
    );
    function onChange() { setIsFullscreen(Boolean(document.fullscreenElement)); }
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  const toggleFullscreen = useCallback(async () => {
    const doc = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const docExit = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    try {
      if (!document.fullscreenElement) {
        if (doc.requestFullscreen) await doc.requestFullscreen();
        else if (doc.webkitRequestFullscreen) await doc.webkitRequestFullscreen();
      } else {
        if (docExit.exitFullscreen) await docExit.exitFullscreen();
        else if (docExit.webkitExitFullscreen) await docExit.webkitExitFullscreen();
      }
    } catch { /* silencioso */ }
  }, []);

  const minutosTurno = turno
    ? Math.max(0, Math.floor((Date.now() - new Date(turno.abierto_at).getTime()) / 60_000))
    : 0;

  return (
    // F1.8: data-surface="internal" → paleta celeste PASE (tokens override
    // en globals.css). Coherente con AdminLayout. Customer-facing (Tienda,
    // MenuQR, KDS) NO usan data-surface.
    <div data-surface="internal" className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Banner offline sticky — aparece solo cuando no hay conexión a Supabase */}
      <OfflineBanner />
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
          <div className="flex items-center gap-1 flex-shrink-0">
            <SyncStatusBadge />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setAllChecksFilters(undefined); setAllChecksOpen(true); }}
              title="Buscar cuentas (atajo: /)"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">Buscar venta</span>
            </Button>

            <Link
              to="/pos/handheld"
              className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Vista mozo (handheld)"
            >
              <Smartphone className="h-4 w-4" />
            </Link>

            {fullscreenSupported && (
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
              >
                {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            )}

            <button
              type="button"
              onClick={toggleTheme}
              className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Cambiar tema"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            <BusyModeButton />

            <UserAvatarMenu />
          </div>
        </div>
      </header>

      <AllChecksModal
        open={allChecksOpen}
        onOpenChange={setAllChecksOpen}
        initialFilters={allChecksFilters}
      />
      <MobileModoMozoBanner />

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
