import { ProductCard, type ProductCardItem } from './ProductCard';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  titulo: string;
  items: ProductCardItem[];
  onAdd: (item: ProductCardItem) => void;
  // 'grid' = grid responsive (default), 'scroll' = horizontal scroll
  // (usado para Popular).
  variante?: 'grid' | 'scroll';
  className?: string;
}

// Sección con título grande + grid o scroll horizontal de cards.
// El id se usa como anchor para scroll-into-view desde la sidebar.
export function SeccionProductos({ id, titulo, items, onAdd, variante = 'grid', className }: Props) {
  if (items.length === 0) return null;

  return (
    <section id={id} className={cn('scroll-mt-20', className)} data-seccion-id={id}>
      <h2 className="text-2xl font-medium text-foreground mb-5">{titulo}</h2>
      {variante === 'scroll' ? (
        <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory scrollbar-thin">
          {items.map((it) => (
            <div key={it.item_id} className="flex-shrink-0 w-[200px] sm:w-[240px] snap-start">
              <ProductCard item={it} onAdd={() => onAdd(it)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {items.map((it) => (
            <ProductCard key={it.item_id} item={it} onAdd={() => onAdd(it)} />
          ))}
        </div>
      )}
    </section>
  );
}
