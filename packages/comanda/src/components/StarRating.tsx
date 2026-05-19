// Componente reusable de rating de estrellas.
// Modo lectura (display) o modo interactivo (input).

import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  value: number;           // 0-5 (puede ser decimal en modo display, ej. 4.3)
  onChange?: (v: number) => void;  // si se pasa, modo interactivo
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;     // mostrar el número al lado
  className?: string;
}

const SIZES = {
  sm: { star: 'h-3.5 w-3.5', text: 'text-xs' },
  md: { star: 'h-4 w-4', text: 'text-sm' },
  lg: { star: 'h-6 w-6', text: 'text-base' },
};

export function StarRating({ value, onChange, size = 'md', showValue = false, className }: Props) {
  const interactive = !!onChange;
  const cls = SIZES[size];

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)}>
      {[1, 2, 3, 4, 5].map((star) => {
        // Si interactivo: marcar las estrellas hasta el valor actual.
        // Si display: usar Math.round(value) para llenado entero (no media estrella).
        const filled = interactive ? value >= star : Math.round(value) >= star;
        return (
          <button
            key={star}
            type="button"
            onClick={interactive ? () => onChange?.(star) : undefined}
            disabled={!interactive}
            className={cn(
              'transition-transform',
              interactive && 'hover:scale-110 cursor-pointer',
              !interactive && 'cursor-default',
            )}
            aria-label={`${star} estrella${star > 1 ? 's' : ''}`}
          >
            <Star
              className={cn(
                cls.star,
                filled
                  ? 'fill-amber-400 text-amber-400'
                  : interactive
                    ? 'text-gray-300 hover:text-amber-300'
                    : 'text-gray-300',
              )}
            />
          </button>
        );
      })}
      {showValue && value > 0 && (
        <span className={cn('ml-1.5 text-muted-foreground', cls.text)}>
          {value.toFixed(1)}
        </span>
      )}
    </div>
  );
}
