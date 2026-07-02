import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { usePermiso } from '@/lib/usePermiso';
import { findActiveCategory, findActiveSubItem } from '@/lib/adminNavigation';
import { AdminSidebar } from './AdminSidebar';
import { AdminHeader } from './AdminHeader';
import { cn } from '@/lib/utils';

// Layout principal del admin (sprint 6). Sidebar fijo desktop / drawer
// mobile + header sticky + outlet del contenido. Reemplaza
// ProtectedShell para todas las rutas admin del sistema.
//
// Verifica:
// 1. Sesión Supabase (si no, /login).
// 2. Permiso para ver la ruta actual (si la ruta declara
//    requiredPermission y el user no lo tiene → redirect a la primera
//    ruta admin con permiso, o /pos si no tiene NINGUNA).
//
// Workaround radix #1241: si abrimos el drawer desde un botón del
// header, body pointer-events queda en 'none' al cerrar. Forzamos auto
// cuando el drawer abre.
export function AdminLayout() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Permiso de la ruta activa.
  const cat = findActiveCategory(pathname);
  const sub = cat ? findActiveSubItem(cat, pathname) : null;
  const requiredCat = cat?.requiredPermission;
  const requiredSub = sub?.requiredPermission;
  // Sprint 7 HIGH #3: pasar slug imposible 'NEVER_MATCH' cuando no hay
  // permiso requerido. usePermiso devuelve false consistentemente para
  // este slug, evitando ambigüedad de '' (slug vacío) que algunas
  // implementaciones podrían tratar diferente.
  const tieneCat = usePermiso(requiredCat || 'NEVER_MATCH');
  const tieneSub = usePermiso(requiredSub || 'NEVER_MATCH');

  // ── Effects (todos antes de cualquier early return para no romper
  // las reglas de hooks) ─────────────────────────────────────────────

  // Cierra el drawer al cambiar de ruta (en mobile, al click sub-item).
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // Workaround radix issue #1241 (mismo que CambiarPinDialog/ManagerOverride).
  useEffect(() => {
    if (drawerOpen) document.body.style.pointerEvents = 'auto';
  }, [drawerOpen]);

  // Sprint 8 tarea 6: a11y del drawer mobile. Cuando abre:
  //   - Auto-focus al primer link del sidebar.
  //   - Escape cierra el drawer.
  //   - Tab queda atrapado dentro del drawer (no se "escapa" al
  //     contenido principal).
  // Implementación manual porque el drawer NO usa shadcn Dialog (que
  // hace esto automático). Ver DEUDA: migrar a Dialog/Sheet en futuro.
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    // Auto-focus el primer focusable visible.
    const focusables = drawer.querySelectorAll<HTMLElement>(
      'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables[0]?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        return;
      }
      if (e.key === 'Tab' && drawer) {
        const items = drawer.querySelectorAll<HTMLElement>(
          'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [drawerOpen]);

  // Si la ruta tiene permiso requerido y el user no lo tiene → redirect.
  // Solo ejecuta si user ya cargó (evita redirects falsos durante loading).
  useEffect(() => {
    if (loading || !user || !cat) return;
    if (requiredCat && !tieneCat) {
      toast.error('Sin permiso para acceder');
      navigate('/reportes/dashboard', { replace: true });
      return;
    }
    if (requiredSub && !tieneSub) {
      toast.error('Sin permiso para acceder');
      navigate(cat.href, { replace: true });
    }
  }, [loading, user, cat, requiredCat, requiredSub, tieneCat, tieneSub, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground bg-background">
        Cargando…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  return (
    // F1.8: data-surface="internal" hace que toda la subtree use la paleta
    // celeste PASE (override de tokens en globals.css). Customer-facing
    // (Tienda, MenúQR) se quedan con el coral default.
    <div data-surface="internal" className="min-h-screen bg-background flex">
      {/* Desktop sidebar — fijo */}
      <AdminSidebar className="hidden lg:flex w-[220px] flex-shrink-0 sticky top-0 h-screen" />

      {/* Mobile drawer */}
      {drawerOpen && (
        <div
          ref={drawerRef}
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menú admin"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <AdminSidebar
            className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] shadow-xl"
            onItemClick={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* Contenido */}
      <div className={cn('flex-1 min-w-0 flex flex-col')}>
        <AdminHeader onOpenSidebar={() => setDrawerOpen(true)} />
        <main className="flex-1 min-h-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
