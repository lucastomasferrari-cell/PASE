import { useEffect, useState } from 'react';
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
  const tieneCat = usePermiso(requiredCat ?? '');
  const tieneSub = usePermiso(requiredSub ?? '');

  // ── Effects (todos antes de cualquier early return para no romper
  // las reglas de hooks) ─────────────────────────────────────────────

  // Cierra el drawer al cambiar de ruta (en mobile, al click sub-item).
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // Workaround radix issue #1241 (mismo que CambiarPinDialog/ManagerOverride).
  useEffect(() => {
    if (drawerOpen) document.body.style.pointerEvents = 'auto';
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
    <div className="min-h-screen bg-background flex">
      {/* Desktop sidebar — fijo */}
      <AdminSidebar className="hidden lg:flex w-60 flex-shrink-0 sticky top-0 h-screen" />

      {/* Mobile drawer */}
      {drawerOpen && (
        <div
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
