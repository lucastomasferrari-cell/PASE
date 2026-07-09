import { UtensilsCrossed, Coffee, Package, Wallet, ArrowLeft, LifeBuoy } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useFeaturesPosModos } from '@/lib/useFeaturesPosModos';
import { useAuthPos } from '@/lib/authPos';
import { useLastPosModo } from '@/lib/lastPosModo';
import { getConsoleErrors } from '@/lib/consoleCapture';
import { AdminAccessDialog } from './dialogs/AdminAccessDialog';
import type { PosModo, RolPos } from '@/types/database';

interface ModoConfig {
  slug: PosModo;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const MODOS: ModoConfig[] = [
  { slug: 'salon',     label: 'Salón',     Icon: UtensilsCrossed },
  { slug: 'mostrador', label: 'Mostrador', Icon: Coffee },
  { slug: 'pedidos',   label: 'Pedidos',   Icon: Package },
];

// Roles POS con acceso directo al admin (sin PIN adicional).
const ROLES_ADMIN: RolPos[] = ['encargado', 'manager', 'dueno'];

export function PosSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { empleado } = useAuthPos();
  const enabledModos = useFeaturesPosModos();
  const lastPosModo = useLastPosModo();
  const [tieneErrores, setTieneErrores] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);

  // Sabemos en qué modo estamos si la URL contiene su slug (/pos/salon, etc)
  // O si estamos en una venta/pedido detalle — ahí el modo lo persistieron esas
  // pantallas en sessionStorage vía lastPosModo.
  const enVentaOPedidoDetalle = /^\/pos\/(venta|pedidos)\//.test(pathname);
  const modoContextual: PosModo | null = enVentaOPedidoDetalle ? (lastPosModo ?? null) : null;

  useEffect(() => {
    function check() { setTieneErrores(getConsoleErrors().length > 0); }
    check();
    const id = setInterval(check, 5000);
    function onClear() { setTieneErrores(false); }
    window.addEventListener('comanda:soporte-errores-vistos', onClear);
    return () => { clearInterval(id); window.removeEventListener('comanda:soporte-errores-vistos', onClear); };
  }, []);

  const linkCls = (active: boolean) => cn(
    'w-[60px] flex flex-col items-center gap-1 py-3 rounded-lg transition-colors touch-target-lg',
    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

  // Al tocar Admin: si el empleado del PIN actual tiene rol admin, va directo.
  // Si no (cajero / bartender), abre el dialog que pide un PIN autorizado.
  function handleAdminClick() {
    if (empleado && ROLES_ADMIN.includes(empleado.rol_pos)) {
      navigate('/catalogo');
      return;
    }
    setAdminDialogOpen(true);
  }

  return (
    <aside className="w-[72px] bg-card border-r border-border flex flex-col items-center py-3 gap-1 flex-shrink-0">
      {/* Modos POS */}
      {MODOS.filter((m) => enabledModos.includes(m.slug)).map(({ slug, label, Icon }) => {
        const active = pathname.startsWith(`/pos/${slug}`) || modoContextual === slug;
        return (
          <Link
            key={slug}
            to={`/pos/${slug}`}
            className={linkCls(active)}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{label}</span>
          </Link>
        );
      })}

      {/* Caja */}
      <Link
        to="/caja"
        className={linkCls(pathname.startsWith('/caja'))}
        aria-label="Caja"
      >
        <Wallet className="h-5 w-5" />
        <span className="text-[10px] font-medium">Caja</span>
      </Link>

      {/* Admin — siempre visible, pero requiere PIN de manager/encargado/dueño. */}
      <button
        type="button"
        onClick={handleAdminClick}
        className={linkCls(false)}
        aria-label="Administración"
        title="Ir al panel de administración (requiere PIN admin)"
      >
        <ArrowLeft className="h-5 w-5" />
        <span className="text-[10px] font-medium">Admin</span>
      </button>

      {/* Ayuda / Soporte — anclada al fondo */}
      <div className="mt-auto flex flex-col items-center gap-1 w-full">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('comanda:toggle-soporte'))}
          className="w-[60px] flex flex-col items-center gap-1 py-3 rounded-lg transition-colors touch-target-lg text-muted-foreground hover:bg-accent hover:text-foreground relative"
        >
          <span className="relative">
            <LifeBuoy className="h-5 w-5" />
            {tieneErrores && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-orange-500 ring-2 ring-card animate-pulse" />
            )}
          </span>
          <span className="text-[10px] font-medium">Ayuda</span>
        </button>
      </div>

      <AdminAccessDialog
        open={adminDialogOpen}
        onOpenChange={setAdminDialogOpen}
        onAuthorized={() => { setAdminDialogOpen(false); navigate('/catalogo'); }}
      />
    </aside>
  );
}
