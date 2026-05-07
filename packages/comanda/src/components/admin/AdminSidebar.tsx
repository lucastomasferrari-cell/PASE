import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { ADMIN_NAVIGATION, findActiveCategory } from '@/lib/adminNavigation';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { useEffect, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { AdminCategoryItem } from './AdminCategoryItem';
import { cn } from '@/lib/utils';

interface Props {
  // Cuando el sidebar se renderiza dentro del drawer mobile, este callback
  // se llama al click de un item para cerrar el drawer.
  onItemClick?: () => void;
  className?: string;
}

// Sidebar permanente del admin. Logo arriba, selector tenant + local,
// 12 categorías navegables, footer con "← Volver al POS" y avatar.
//
// La detección de "categoría activa" se hace via pathname: cuando el user
// está en /menu/* la categoría Menu queda highlighted y sus sub-items
// expandidos. El click en otra categoría navega a su href default y
// expande sus sub-items.
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
    <aside className={cn('flex flex-col h-full bg-card border-r border-border', className)}>
      {/* Header marca + selector */}
      <div className="px-4 py-4 border-b border-border">
        <Link to="/reportes/dashboard" className="block text-base font-semibold tracking-tight text-foreground">
          COMANDA
        </Link>
        {locales.length > 1 ? (
          <Select
            value={localId !== null ? String(localId) : ''}
            onValueChange={(v) => setLocalActivo(Number(v))}
          >
            <SelectTrigger className="h-8 mt-2 text-xs">
              <SelectValue placeholder="Elegí local…" />
            </SelectTrigger>
            <SelectContent>
              {locales.map((l) => (
                <SelectItem key={l.id} value={String(l.id)} className="text-xs">
                  {l.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : locales.length === 1 ? (
          <p className="text-xs text-muted-foreground mt-1">{locales[0]!.nombre}</p>
        ) : null}
      </div>

      {/* Categorías */}
      <nav className="flex-1 overflow-y-auto p-2 space-y-1" aria-label="Navegación admin">
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

      {/* Footer: volver al POS + avatar */}
      <div className="border-t border-border p-2 space-y-1 flex-shrink-0">
        <Link
          to="/pos"
          onClick={onItemClick}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver al POS
        </Link>
        <div className="px-3 py-2 flex items-center gap-2">
          <UserAvatarMenu />
          {user && (
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{user.email ?? 'Sin email'}</div>
              <div className="text-[10px] text-muted-foreground capitalize">{user.rol}</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
