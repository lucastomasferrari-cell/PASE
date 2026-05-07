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
// - Sub-items expandidos cuando la categoría está activa.
// - Filtrado de sub-items según permiso individual.
//
// onItemClick: callback opcional para cerrar el drawer mobile al elegir
// un sub-item.
export function AdminCategoryItem({
  label, icon: Icon, href, requiredPermission, subItems, expanded, onItemClick,
}: Props) {
  const tienePermisoCategoria = usePermiso(requiredPermission ?? '');
  const { pathname } = useLocation();

  // Si la categoría no tiene permiso, no renderizamos.
  // Si requiredPermission es undefined, asumimos que es público.
  if (requiredPermission && !tienePermisoCategoria) return null;

  return (
    <div className="space-y-0.5">
      <Link
        to={href}
        onClick={onItemClick}
        className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
          expanded
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-foreground/70 hover:bg-accent hover:text-foreground',
        )}
        aria-current={expanded ? 'page' : undefined}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight className={cn(
          'h-3.5 w-3.5 flex-shrink-0 transition-transform',
          expanded && 'rotate-90',
        )} />
      </Link>
      {expanded && (
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
