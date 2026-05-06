import { cn } from '@/lib/utils';

export interface PillOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: PillOption<T>[];
  className?: string;
}

// Selector de pills estilo Roc N Ramen — 2-3 pills horizontales,
// activo con borde negro 2px y bullet "•", inactivo con fondo gris
// claro. Usado para Pickup/Delivery en la tienda online.
export function PillSelector<T extends string>({ value, onChange, options, className }: Props<T>) {
  return (
    <div className={cn('flex gap-2', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-2 px-5 h-11 rounded-full border-2 text-sm font-medium transition-colors',
              active
                ? 'bg-white border-black text-black'
                : 'bg-gray-50 border-transparent text-gray-500 hover:bg-gray-100',
              opt.disabled && 'opacity-40 cursor-not-allowed hover:bg-gray-50',
            )}
            aria-pressed={active}
          >
            {active && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-black" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
