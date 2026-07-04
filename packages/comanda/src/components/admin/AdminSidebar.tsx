import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { ADMIN_NAVIGATION, findActiveCategory } from '@/lib/adminNavigation';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { useEffect, useState } from 'react';
import { AdminCategoryItem } from './AdminCategoryItem';
import { cn } from '@/lib/utils';


interface Props {
  onItemClick?: () => void;
  className?: string;
}

export function AdminSidebar({ onItemClick, className }: Props) {
  const { user } = useAuth();
  const [localId, setLocalActivo] = useLocalActivo(user);
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const { pathname } = useLocation();
  const activeCategory = findActiveCategory(pathname);

  useEffect(() => {
    listLocalesAccesibles().then((r) => setLocales(r.data));
  }, []);

  return (
    <aside className={cn('cm-sb', className)}>
      {/* Header marca */}
      <div className="cm-sb-header">
        <Link to="/reportes/dashboard" className="cm-sb-brand">
          comanda<span className="brand-dot">.</span>
        </Link>
      </div>

      {/* Selector de local */}
      {locales.length > 1 ? (
        <div className="cm-sb-local">
          <select
            value={localId !== null ? String(localId) : ''}
            onChange={(e) => setLocalActivo(Number(e.target.value))}
          >
            {locales.map((l) => (
              <option key={l.id} value={String(l.id)}>{l.nombre}</option>
            ))}
          </select>
        </div>
      ) : locales.length === 1 ? (
        <div className="cm-sb-local">
          <p className="cm-sb-local-single">{locales[0]!.nombre}</p>
        </div>
      ) : null}

      {/* Categorías */}
      <nav className="cm-sb-nav" aria-label="Navegación admin">
        {ADMIN_NAVIGATION.map((cat) => (
          <AdminCategoryItem
            key={cat.slug}
            label={cat.label}
            icon={cat.icon}
            href={cat.href}
            requiredPermission={cat.requiredPermission}
            subItems={cat.subItems}
            expanded={activeCategory?.slug === cat.slug}
            onItemClick={onItemClick}
          />
        ))}
      </nav>

      <div style={{ flex: 1 }} />
    </aside>
  );
}
