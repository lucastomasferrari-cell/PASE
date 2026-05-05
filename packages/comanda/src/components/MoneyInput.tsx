import { useState, useEffect } from 'react';
import { formatARS, parseARS } from '../lib/format';

export interface MoneyInputProps {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  style?: React.CSSProperties;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function MoneyInput({
  value, onChange, disabled, autoFocus, placeholder, ariaLabel, style, onBlur, onKeyDown,
}: MoneyInputProps) {
  const [text, setText] = useState<string>(formatARS(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatARS(value));
  }, [value, focused]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? '$0,00'}
      aria-label={ariaLabel ?? 'monto'}
      disabled={disabled}
      autoFocus={autoFocus}
      onFocus={() => {
        setFocused(true);
        // Mostrar el número crudo al focusear, más fácil de editar
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
      style={{
        padding: '6px 10px',
        border: '1px solid #D1D5DB',
        borderRadius: 6,
        fontSize: 14,
        textAlign: 'right',
        width: '100%',
        ...style,
      }}
    />
  );
}
