import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { usePermiso } from '@/lib/usePermiso';
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

export function AdminCategoryItem({
  label, icon: Icon, href, requiredPermission, subItems, expanded, onItemClick,
}: Props) {
  const tienePermisoCategoria = usePermiso(requiredPermission ?? '');
  const { pathname } = useLocation();

  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  useEffect(() => { setManualOverride(null); }, [expanded]);

  const isOpen = manualOverride ?? expanded;

  if (requiredPermission && !tienePermisoCategoria) return null;

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setManualOverride(!isOpen);
  }

  return (
    <div className="cm-sb-group">
      <Link
        to={href}
        onClick={onItemClick}
        className={`cm-nav-item${expanded ? ' active' : ''}`}
        aria-current={expanded ? 'page' : undefined}
      >
        <Icon style={{ width: 16, height: 16, flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {subItems.length > 0 && (
          <ChevronRight
            className={`cm-nav-chevron${isOpen ? ' open' : ''}`}
            style={{ width: 14, height: 14 }}
            onClick={toggle}
          />
        )}
      </Link>
      {isOpen && subItems.length > 0 && (
        <div style={{ marginTop: 2 }}>
          {subItems.map((s) => (
            <SubItem key={s.slug} item={s} pathname={pathname} onClick={onItemClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubItem({ item, pathname, onClick }: { item: NavSubItem; pathname: string; onClick?: () => void }) {
  const tienePermisoSub = usePermiso(item.requiredPermission ?? '');
  if (item.requiredPermission && !tienePermisoSub) return null;

  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');

  return (
    <Link
      to={item.href}
      onClick={onClick}
      className={`cm-sub-item${isActive ? ' active' : ''}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
    </Link>
  );
}
