import { forwardRef, useEffect, useState, useRef, useImperativeHandle } from 'react';

// CurrencyInput — input con currency mask estilo apps de banco AR.
// Reemplaza patron viejo `<input type="number" value={form.x}>` que en
// AR rechaza la coma decimal silenciosamente y deja el campo vacío
// (causa raíz del bug del neto gravado de carga manual de factura).
//
// Estado interno: centavos como integer (evita errores floating-point).
// Callback onChange: valor en pesos como number (15.000,50 → 15000.50).
//
// Versión PASE: sin dependencia de tailwind/cn (PASE usa styles inline
// + CSS vars). Funcionalidad idéntica a la de COMANDA. Cuando se
// extraiga a @pase/shared, mantener UNA sola implementación con el
// estilo más versátil.

interface CurrencyInputProps {
  value: number;
  onChange: (valueInPesos: number) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  currencySymbol?: string | null;
  allowNegative?: boolean;
  maxIntegerDigits?: number;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  required?: boolean;
  name?: string;
  'data-testid'?: string;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
}

const FORMATTER_AR = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/* eslint-disable react-refresh/only-export-components --
 * Estos helpers viven en el mismo archivo que el componente para mantener
 * el módulo cohesionado y porque NO se importan desde fuera (son internos
 * + testeables). React-refresh no los detecta como componentes y se queja,
 * pero el módulo es estable (no hot-reload de helpers). */
export function formatCents(cents: number): string {
  return FORMATTER_AR.format(cents / 100);
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}

export function centsToPesos(cents: number): number {
  return cents / 100;
}

export function applyDigit(cents: number, digit: number): number {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const newAbs = abs * 10 + digit;
  return negative ? -newAbs : newAbs;
}

export function applyBackspace(cents: number): number {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const newAbs = Math.floor(abs / 10);
  return negative ? -newAbs : newAbs;
}

export function parsePastedToCents(pasted: string, allowNegative: boolean): number | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;

  const isNegative = allowNegative && /^-|^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;

  const decimalMatch = trimmed.match(/[.,](\d{1,2})$/);
  let parsedCents: number;

  if (decimalMatch) {
    const decimalPart = (decimalMatch[1] ?? '00').padEnd(2, '0');
    const integerPart = digits.slice(0, digits.length - (decimalMatch[1]?.length ?? 0));
    parsedCents = parseInt((integerPart || '0') + decimalPart, 10);
  } else {
    parsedCents = parseInt(digits, 10) * 100;
  }

  if (Number.isNaN(parsedCents)) return null;
  return isNegative ? -parsedCents : parsedCents;
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    {
      value,
      onChange,
      disabled = false,
      autoFocus = false,
      placeholder,
      currencySymbol = '$',
      allowNegative = false,
      maxIntegerDigits = 12,
      className,
      style,
      id,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedby,
      required,
      name,
      'data-testid': testId,
      onBlur,
      onFocus,
    },
    ref,
  ) {
    const innerRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => innerRef.current!, []);

    const [cents, setCents] = useState<number>(() => pesosToCents(value));

    useEffect(() => {
      const newCents = pesosToCents(value);
      setCents((current) => (newCents !== current ? newCents : current));
    }, [value]);

    const maxCents = Math.pow(10, maxIntegerDigits + 2) - 1;

    function commitCents(newCents: number) {
      let clamped = newCents;
      if (!allowNegative && clamped < 0) clamped = 0;
      if (Math.abs(clamped) > maxCents) {
        clamped = clamped > 0 ? maxCents : -maxCents;
      }
      setCents(clamped);
      onChange(centsToPesos(clamped));
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (
        e.key === 'Tab' ||
        e.key === 'Enter' ||
        e.key === 'Escape' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        (e.key.startsWith('F') && e.key.length > 1)
      ) {
        return;
      }

      e.preventDefault();

      if (e.key === 'Backspace' || e.key === 'Delete') {
        commitCents(applyBackspace(cents));
        return;
      }

      if (e.key === '-' && allowNegative) {
        commitCents(-cents);
        return;
      }

      if (/^[0-9]$/.test(e.key)) {
        commitCents(applyDigit(cents, parseInt(e.key, 10)));
        return;
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text');
      const parsedCents = parsePastedToCents(pasted, allowNegative);
      if (parsedCents !== null) commitCents(parsedCents);
    }

    function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
      e.target.select();
      onFocus?.(e);
    }

    const display = formatCents(cents);

    const wrapperStyle: React.CSSProperties = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      width: '100%',
      ...style,
    };

    const inputStyle: React.CSSProperties = {
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
      width: '100%',
      paddingLeft: currencySymbol !== null ? 24 : undefined,
    };

    return (
      <div style={wrapperStyle}>
        {currencySymbol !== null && (
          <span style={{
            position: 'absolute',
            left: 8,
            color: 'var(--muted2, #888)',
            pointerEvents: 'none',
            userSelect: 'none',
            fontSize: 12,
          }}>
            {currencySymbol}
          </span>
        )}
        <input
          ref={innerRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          autoFocus={autoFocus}
          value={display}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={handleFocus}
          onBlur={onBlur}
          onChange={() => { /* controlled */ }}
          placeholder={placeholder}
          id={id}
          name={name}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedby}
          required={required}
          data-testid={testId}
          className={className}
          style={inputStyle}
        />
      </div>
    );
  },
);
