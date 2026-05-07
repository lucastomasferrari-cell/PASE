import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { ADMIN_NAVIGATION, findActiveCategory, findActiveSubItem } from '@/lib/adminNavigation';

// Breadcrumb dinámico que parsea el pathname y arma "Categoría > SubItem".
// Si la ruta no matchea ninguna categoría conocida (raro), no renderiza.
export function AdminBreadcrumb() {
  const { pathname } = useLocation();
  const cat = findActiveCategory(pathname);
  if (!cat) return null;
  const sub = findActiveSubItem(cat, pathname);

  return (
    <nav className="flex items-center text-xs text-muted-foreground gap-1.5" aria-label="Breadcrumb">
      <Link
        to={cat.href}
        className="hover:text-foreground transition-colors"
      >
        {cat.label}
      </Link>
      {sub && (
        <>
          <ChevronRight className="h-3 w-3 flex-shrink-0" />
          <span className="text-foreground font-medium">{sub.label}</span>
        </>
      )}
    </nav>
  );
}

// Re-export para uso interno (App.tsx no lo necesita pero está bueno
// tenerlo por si algún componente quiere imprimir su lugar en la nav).
export { ADMIN_NAVIGATION };
