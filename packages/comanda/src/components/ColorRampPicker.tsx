import { cn } from '@/lib/utils';

// Set canónico de color_ramps soportados — coincide con el CHECK
// constraint de item_grupos.color_ramp (migration 202605061200) y con
// las clases tailwind que el POS usa para los tiles (bg-{color}-100 +
// border-{color}-900). Mantener en sync con ambos lugares.
export const COLOR_RAMPS = [
  'amber', 'pink', 'purple', 'blue', 'coral', 'teal', 'green', 'gray',
] as const;

export type ColorRamp = typeof COLOR_RAMPS[number];

// Mapping color_ramp → clases tailwind. coral mapea a orange-* porque
// no existe color "coral" en tailwind core (es la convención del repo).
const RAMP_CLASSES: Record<ColorRamp, { bg: string; border: string }> = {
  amber:  { bg: 'bg-amber-100',  border: 'border-amber-900' },
  pink:   { bg: 'bg-pink-100',   border: 'border-pink-900' },
  purple: { bg: 'bg-purple-100', border: 'border-purple-900' },
  blue:   { bg: 'bg-blue-100',   border: 'border-blue-900' },
  coral:  { bg: 'bg-orange-100', border: 'border-orange-900' },
  teal:   { bg: 'bg-teal-100',   border: 'border-teal-900' },
  green:  { bg: 'bg-green-100',  border: 'border-green-900' },
  gray:   { bg: 'bg-gray-100',   border: 'border-gray-900' },
};

interface Props {
  value: ColorRamp | null;
  onChange: (v: ColorRamp | null) => void;
  className?: string;
}

// Selector visual de color_ramp. 8 chips circulares, click para seleccionar
// y click en el seleccionado lo des-selecciona (NULL → fallback gray en POS).
export function ColorRampPicker({ value, onChange, className }: Props) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="radiogroup" aria-label="Color del grupo">
      {COLOR_RAMPS.map((ramp) => {
        const classes = RAMP_CLASSES[ramp];
        const selected = value === ramp;
        return (
          <button
            key={ramp}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected ? null : ramp)}
            title={ramp}
            className={cn(
              'h-10 w-10 rounded-full border-2 transition-all',
              classes.bg,
              selected
                ? 'border-black scale-110 shadow-sm'
                : 'border-transparent hover:scale-105 hover:border-gray-300',
            )}
          />
        );
      })}
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-foreground/60 hover:text-foreground self-center px-2 underline"
        >
          Sin color
        </button>
      )}
    </div>
  );
}
