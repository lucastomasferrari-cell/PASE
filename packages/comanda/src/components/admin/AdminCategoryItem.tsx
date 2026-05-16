import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { usePermiso } from '@/lib/usePermiso';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NavSubItem } from '@/lib/adminNavigation';

interface Props {
  label: string;
  icon: LucideIcon;
  href: string;
  requiredPermission?: string;
  subItems: NavSubItem[];
  expanded: boolean;
  onItemClick?: () => void;
}

// Item de categoría del sidebar admin. Maneja:
// - Verificación de permiso (si falta, no renderiza nada).
// - Estado activo según pathname.
// - Sub-items expandidos: por default cuando la categoría está activa,
//   pero el user puede colapsar/expandir manualmente con el chevron.
// - Filtrado de sub-items según permiso individual.
//
// onItemClick: callback opcional para cerrar el drawer mobile al elegir
// un sub-item.
export function AdminCategoryItem({
  label, icon: Icon, href, requiredPermission, subItems, expanded, onItemClick,
}: Props) {
  const tienePermisoCategoria = usePermiso(requiredPermission ?? '');
  const { pathname } = useLocation();

  // Override manual del expandido. null = sigue al prop "expanded" (categoría
  // activa). true/false = el user clickeó el chevron para forzar estado.
  // Cuando cambia la categoría activa (expanded prop cambia), reseteamos el
  // override para que el comportamiento default vuelva a funcionar.
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  useEffect(() => { setManualOverride(null); }, [expanded]);

  const isOpen = manualOverride ?? expanded;

  // Si la categoría no tiene permiso, no renderizamos.
  if (requiredPermission && !tienePermisoCategoria) return null;

  function toggleChevron(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setManualOverride(!isOpen);
  }

  return (
    <div className="space-y-0.5">
      <div className={cn(
        'flex items-stretch rounded-md transition-colors',
        expanded
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-foreground/70 hover:bg-accent hover:text-foreground',
      )}>
        <Link
          to={href}
          onClick={onItemClick}
          className="flex items-center gap-3 px-3 py-2 text-sm flex-1 min-w-0 rounded-l-md"
          aria-current={expanded ? 'page' : undefined}
        >
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1 truncate">{label}</span>
        </Link>
        {subItems.length > 0 && (
          <button
            type="button"
            onClick={toggleChevron}
            aria-label={isOpen ? `Colapsar ${label}` : `Expandir ${label}`}
            aria-expanded={isOpen}
            className="px-2 hover:bg-foreground/5 rounded-r-md flex items-center"
          >
            <ChevronRight className={cn(
              'h-3.5 w-3.5 flex-shrink-0 transition-transform',
              isOpen && 'rotate-90',
            )} />
          </button>
        )}
      </div>
      {isOpen && (
        <ul className="space-y-0.5 pl-9">
          {subItems.map((s) => (
            <SubItem key={s.slug} item={s} pathname={pathname} onClick={onItemClick} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubItem({ item, pathname, onClick }: { item: NavSubItem; pathname: string; onClick?: () => void }) {
  const tienePermisoSub = usePermiso(item.requiredPermission ?? '');
  // Si la sub-item declara permiso y el user no lo tiene, ocultar.
  if (item.requiredPermission && !tienePermisoSub) return null;

  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');

  return (
    <li>
      <Link
        to={item.href}
        onClick={onClick}
        className={cn(
          'flex items-center justify-between px-3 py-1.5 rounded-md text-[13px] transition-colors',
          isActive
            ? 'text-primary font-medium'
            : 'text-foreground/60 hover:text-foreground hover:bg-accent/50',
        )}
        aria-current={isActive ? 'page' : undefined}
      >
        <span className="truncate">{item.label}</span>
        {item.badge && (
          <Badge
            variant={item.badge === 'soon' ? 'outline' : 'secondary'}
            className="text-[9px] px-1.5 py-0 h-4 ml-2 flex-shrink-0"
          >
            {item.badge === 'soon' ? 'Próximamente' : item.badge}
          </Badge>
        )}
      </Link>
    </li>
  );
}
