import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { formatARS, parseARS } from '../lib/format';
import { cn } from '@/lib/utils';

export interface MoneyInputProps {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function MoneyInput({
  value, onChange, disabled, autoFocus, placeholder, ariaLabel, className, onBlur, onKeyDown,
}: MoneyInputProps) {
  const [text, setText] = useState<string>(formatARS(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatARS(value));
  }, [value, focused]);

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? '$0,00'}
      aria-label={ariaLabel ?? 'monto'}
      disabled={disabled}
      autoFocus={autoFocus}
      onFocus={() => {
        setFocused(true);
        setText(value === 0 ? '' : String(value).replace('.', ','));
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        const n = parseARS(text);
        onChange(n);
        setText(formatARS(n));
        onBlur?.();
      }}
      onKeyDown={onKeyDown}
      className={cn('h-11 text-right tabular-nums', className)}
    />
  );
}
