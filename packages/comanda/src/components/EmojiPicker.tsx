import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const EMOJIS_GASTRO = [
  '🍔', '🌭', '🍕', '🌮', '🌯', '🥙', '🥗', '🍝', '🍜', '🍣',
  '🍤', '🍗', '🥩', '🥪', '🍳', '🥞', '🧇', '🥐', '🥖', '🧀',
  '🍟', '🍿', '🥨', '🍩', '🍪', '🎂', '🧁', '🍰', '🍮', '🍦',
  '☕', '🥤', '🍺', '🍷', '🍹', '🧉',
];

export interface EmojiPickerProps {
  value: string | null;
  onChange: (emoji: string | null) => void;
}

export function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block">
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-label="Elegir emoji"
        className="h-11 min-w-[48px] text-xl px-3"
      >
        {value ?? '😀'}
      </Button>

      {open && (
        <div
          className="absolute top-full left-0 z-50 mt-1 p-2 grid grid-cols-8 gap-1 w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
          role="dialog"
          aria-label="Selector de emoji"
        >
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            title="Sin emoji"
            className={cn(
              'flex items-center justify-center h-9 w-9 rounded-md',
              'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <X className="h-4 w-4" />
          </button>
          {EMOJIS_GASTRO.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { onChange(e); setOpen(false); }}
              className={cn(
                'flex items-center justify-center h-9 w-9 rounded-md text-xl',
                'hover:bg-accent transition-colors',
                value === e && 'ring-2 ring-primary',
              )}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
