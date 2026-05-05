import { UtensilsCrossed, Coffee, Package } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useFeaturesPosModos } from '@/lib/useFeaturesPosModos';
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

// Sidebar permanente de 72px con SOLO 3 modos POS. Filtra según
// features_pos_modos del local activo. NO incluye Caja (botón en header)
// ni Settings (link "Admin" en header).
export function PosSidebar() {
  const { pathname } = useLocation();
  const enabledModos = useFeaturesPosModos();

  return (
    <aside className="w-[72px] bg-card border-r border-border flex flex-col items-center py-3 gap-2 flex-shrink-0">
      {MODOS.filter((m) => enabledModos.includes(m.slug)).map(({ slug, label, Icon }) => {
        const active = pathname.startsWith(`/pos/${slug}`);
        return (
          <Link
            key={slug}
            to={`/pos/${slug}`}
            className={cn(
              'w-[60px] flex flex-col items-center gap-1 py-3 rounded-lg transition-colors touch-target-lg',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{label}</span>
          </Link>
        );
      })}
    </aside>
  );
}
