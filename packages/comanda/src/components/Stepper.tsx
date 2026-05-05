import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: 'default' | 'lg';
}

export function Stepper({ value, onChange, min = 0, max = 999, step = 1, size = 'default' }: Props) {
  const btnSize = size === 'lg' ? 'h-11 w-11' : 'h-9 w-9';
  const inputWidth = size === 'lg' ? 'w-16 text-lg' : 'w-12';

  return (
    <div className="inline-flex items-center border border-input rounded-md overflow-hidden bg-background">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange(Math.max(min, value - step))}
        className={cn(btnSize, 'rounded-none border-r border-input')}
        aria-label="Restar"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className={cn(
          inputWidth,
          'text-center bg-transparent border-0 outline-none tabular-nums text-base',
        )}
        min={min}
        max={max}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange(Math.min(max, value + step))}
        className={cn(btnSize, 'rounded-none border-l border-input')}
        aria-label="Sumar"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
