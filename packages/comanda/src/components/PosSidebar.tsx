import { UtensilsCrossed, Coffee, Package, Wallet, ArrowLeft, LifeBuoy } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useFeaturesPosModos } from '@/lib/useFeaturesPosModos';
import { usePermiso } from '@/lib/usePermiso';
import { getConsoleErrors } from '@/lib/consoleCapture';
import type { PosModo } from '@/types/database';

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

export function PosSidebar() {
  const { pathname } = useLocation();
  const enabledModos = useFeaturesPosModos();
  const puedeAdmin = usePermiso('comanda.config.editar');
  const [tieneErrores, setTieneErrores] = useState(false);

  useEffect(() => {
    function check() { setTieneErrores(getConsoleErrors().length > 0); }
    check();
    const id = setInterval(check, 5000);
    // Cuando el widget se abre y limpia errores, actualizar inmediatamente
    function onClear() { setTieneErrores(false); }
    window.addEventListener('comanda:soporte-errores-vistos', onClear);
    return () => { clearInterval(id); window.removeEventListener('comanda:soporte-errores-vistos', onClear); };
  }, []);

  const linkCls = (active: boolean) => cn(
    'w-[60px] flex flex-col items-center gap-1 py-3 rounded-lg transition-colors touch-target-lg',
    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

  return (
    <aside className="w-[72px] bg-card border-r border-border flex flex-col items-center py-3 gap-1 flex-shrink-0">
      {/* Modos POS */}
      {MODOS.filter((m) => enabledModos.includes(m.slug)).map(({ slug, label, Icon }) => {
        const active = pathname.startsWith(`/pos/${slug}`);
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

      {/* Admin (solo si tiene permiso) */}
      {puedeAdmin && (
        <Link
          to="/catalogo"
          className={linkCls(false)}
          aria-label="Administración"
          title="Ir al panel de administración"
        >
          <ArrowLeft className="h-5 w-5" />
          <span className="text-[10px] font-medium">Admin</span>
        </Link>
      )}

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
    </aside>
  );
}
