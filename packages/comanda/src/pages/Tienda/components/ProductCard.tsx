import { Plus } from 'lucide-react';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface ProductCardItem {
  item_id: number;
  nombre: string;
  descripcion?: string | null;
  emoji?: string | null;
  foto_url?: string | null;
  precio: number;
  grupo_color_ramp?: string | null;
}

interface Props {
  item: ProductCardItem;
  onAdd: () => void;
  className?: string;
}

// Mapa color_ramp → clases tailwind para el fallback sin foto.
// Mismas tonalidades 100/900 que usa el POS para los tiles.
const RAMP_BG: Record<string, string> = {
  amber:  'bg-amber-100  text-amber-900',
  pink:   'bg-pink-100   text-pink-900',
  purple: 'bg-purple-100 text-purple-900',
  blue:   'bg-blue-100   text-blue-900',
  coral:  'bg-orange-100 text-orange-900',
  teal:   'bg-teal-100   text-teal-900',
  green:  'bg-green-100  text-green-900',
  gray:   'bg-gray-100   text-gray-900',
};

// Card de producto estilo Roc N Ramen: imagen cuadrada protagonista
// con botón "+" flotante. Sin border, sin shadow — la imagen sola es la
// card. Texto debajo (nombre + precio) en negro/gris.
export function ProductCard({ item, onAdd, className }: Props) {
  const ramp = item.grupo_color_ramp ?? 'gray';
  const fallbackBg = RAMP_BG[ramp] ?? RAMP_BG.gray!;
  const inicial = item.nombre?.[0]?.toUpperCase() ?? '?';

  return (
    <article className={cn('group flex flex-col cursor-pointer', className)} onClick={onAdd}>
      <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-gray-100">
        {item.foto_url ? (
          <img
            src={item.foto_url}
            alt={item.nombre}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02] group-hover:opacity-95"
          />
        ) : (
          <div className={cn('absolute inset-0 flex items-center justify-center', fallbackBg)}>
            {item.emoji ? (
              <span className="text-6xl">{item.emoji}</span>
            ) : (
              <span className="text-5xl font-medium opacity-60">{inicial}</span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          aria-label={`Agregar ${item.nombre}`}
          className="absolute bottom-3 right-3 h-10 w-10 rounded-full bg-white shadow-md flex items-center justify-center hover:scale-110 transition-transform"
        >
          <Plus className="h-5 w-5 text-black" />
        </button>
      </div>
      <div className="mt-3 px-1">
        <div className="text-sm font-medium text-foreground line-clamp-2 leading-snug">{item.nombre}</div>
        <div className="text-sm font-medium text-foreground mt-1">{formatARS(item.precio)}</div>
      </div>
    </article>
  );
}
