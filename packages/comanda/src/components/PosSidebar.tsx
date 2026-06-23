import { UtensilsCrossed, Coffee, Package, Smartphone, Wallet, ArrowLeft, LifeBuoy, Moon, Sun, Maximize2, Minimize2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useFeaturesPosModos } from '@/lib/useFeaturesPosModos';
import { usePermiso } from '@/lib/usePermiso';
import { useTheme } from '@/hooks/useTheme';
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

function SidebarItem({
  label, active, onClick, children,
}: { label: string; active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-[60px] flex flex-col items-center gap-1 py-3 rounded-lg transition-colors touch-target-lg',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

export function PosSidebar() {
  const { pathname } = useLocation();
  const enabledModos = useFeaturesPosModos();
  const puedeAdmin = usePermiso('comanda.config.editar');
  const { theme, toggleTheme } = useTheme();

  // Fullscreen toggle inline (mismo logic que FullscreenToggle.tsx)
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

      {/* Sección inferior */}
      <div className="mt-auto flex flex-col items-center gap-1 w-full">
        {/* Vista mozo handheld */}
        <Link
          to="/pos/handheld"
          className={linkCls(pathname === '/pos/handheld')}
          aria-label="Modo mozo handheld"
          title="Vista optimizada celu/tablet chica para mozos en mesa"
        >
          <Smartphone className="h-5 w-5" />
          <span className="text-[10px] font-medium">Mozo</span>
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

        {/* Fullscreen (solo si el browser lo soporta) */}
        {fullscreenSupported && (
          <SidebarItem label={isFullscreen ? 'Salir' : 'Full'} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </SidebarItem>
        )}

        {/* Tema */}
        <SidebarItem label="Tema" onClick={toggleTheme}>
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </SidebarItem>

        {/* Ayuda / Soporte — abre el widget vía evento global */}
        <SidebarItem
          label="Ayuda"
          onClick={() => window.dispatchEvent(new CustomEvent('comanda:toggle-soporte'))}
        >
          <LifeBuoy className="h-5 w-5" />
        </SidebarItem>
      </div>
    </aside>
  );
}
