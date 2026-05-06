import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CategoriaItem {
  id: number | string;       // 'popular' | 'discounts' | grupo_id
  nombre: string;
  emoji?: string | null;
}

interface Props {
  categorias: CategoriaItem[];
  activa: string | number | null;
  onClick: (id: string | number) => void;
  search: string;
  onSearchChange: (v: string) => void;
}

// Sidebar de categorías estilo Roc N Ramen — fija, 240px, con search
// arriba y lista de categorías scrolleable. La activa va en negro pleno
// con texto blanco. Solo desktop (md:flex). En mobile se reemplaza por
// tabs scroll horizontal arriba (handled by parent).
export function CategoriaSidebar({ categorias, activa, onClick, search, onSearchChange }: Props) {
  return (
    <aside className="hidden md:flex flex-col w-60 flex-shrink-0 border-r border-gray-200 bg-white">
      <div className="p-4 border-b border-gray-100">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar en el menú"
            className="w-full h-10 pl-9 pr-3 rounded-md border border-gray-200 bg-white text-sm placeholder:text-gray-400 focus:outline-none focus:border-gray-400"
          />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5" aria-label="Categorías">
        {categorias.map((c) => {
          const isActive = String(c.id) === String(activa);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onClick(c.id)}
              className={cn(
                'w-full text-left px-4 py-3 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-black text-white font-medium'
                  : 'text-foreground/70 hover:bg-gray-50 hover:text-foreground',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              {c.emoji && <span className="mr-2">{c.emoji}</span>}
              {c.nombre}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// Versión mobile: tabs scrolleables horizontales para reemplazar el
// sidebar en pantallas chicas. Diseño más compacto.
export function CategoriaTabs({ categorias, activa, onClick }: Omit<Props, 'search' | 'onSearchChange'>) {
  return (
    <div className="md:hidden border-b border-gray-200 bg-white sticky top-[57px] z-20">
      <div className="overflow-x-auto whitespace-nowrap px-3 py-2 scrollbar-thin">
        {categorias.map((c) => {
          const isActive = String(c.id) === String(activa);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onClick(c.id)}
              className={cn(
                'inline-block mr-2 px-4 py-2 rounded-full text-sm transition-colors',
                isActive
                  ? 'bg-black text-white font-medium'
                  : 'text-foreground/70 bg-gray-100 hover:bg-gray-200',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              {c.emoji && <span className="mr-1">{c.emoji}</span>}
              {c.nombre}
            </button>
          );
        })}
      </div>
    </div>
  );
}
