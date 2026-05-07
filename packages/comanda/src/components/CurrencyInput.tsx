import { forwardRef, useEffect, useState, useRef, useImperativeHandle } from 'react';
import { cn } from '@/lib/utils';

// CurrencyInput — input con currency mask estilo apps de banco AR
// (Mercado Pago, Brubank, Modo). El usuario solo tipea dígitos; el
// formato se aplica automáticamente.
//
// Estado interno: centavos como integer (evita errores de floating-point).
// Callback onChange: valor en pesos como number (15.000,50 → 15000.50).
//
// Reemplaza patron viejo `<input type="number" value={form.x}>` que en
// AR rechaza la coma decimal silenciosamente y deja el campo vacío.

interface CurrencyInputProps {
  /** Valor en pesos (no centavos). Ej: 15000.50 */
  value: number;
  /** Callback cuando cambia el valor. Recibe el valor en pesos. */
  onChange: (valueInPesos: number) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Símbolo de moneda fuera del input. Default '$'. null para ocultar. */
  currencySymbol?: string | null;
  /** Permite valores negativos. Default false. */
  allowNegative?: boolean;
  /** Máximo de dígitos enteros (sin decimales). Default 12. */
  maxIntegerDigits?: number;
  className?: string;
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

// ─── Helpers exportados (testeables sin React DOM) ─────────────────

export function formatCents(cents: number): string {
  return FORMATTER_AR.format(cents / 100);
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}

export function centsToPesos(cents: number): number {
  return cents / 100;
}

/** Aplica un dígito (0-9) al valor actual de centavos. Mask: shift left + add. */
export function applyDigit(cents: number, digit: number): number {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const newAbs = abs * 10 + digit;
  return negative ? -newAbs : newAbs;
}

/** Aplica backspace al valor actual de centavos. Divide por 10. */
export function applyBackspace(cents: number): number {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const newAbs = Math.floor(abs / 10);
  return negative ? -newAbs : newAbs;
}

/**
 * Parsea un texto pegado y devuelve los centavos correspondientes.
 * Soporta formatos:
 *   "1.500,50" (AR)
 *   "1,500.50" (US)
 *   "1500.5"   (decimal simple)
 *   "1500"     (integer plano → multiplica por 100)
 *   "$ 1.500,50" (con símbolo)
 *   "-100"     (negativo)
 */
export function parsePastedToCents(pasted: string, allowNegative: boolean): number | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;

  const isNegative = allowNegative && /^-|^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Detectar si tiene separador decimal (último punto/coma con 1-2 dígitos después).
  const decimalMatch = trimmed.match(/[.,](\d{1,2})$/);
  let parsedCents: number;

  if (decimalMatch) {
    const decimalPart = (decimalMatch[1] ?? '00').padEnd(2, '0');
    const integerPart = digits.slice(0, digits.length - (decimalMatch[1]?.length ?? 0));
    parsedCents = parseInt((integerPart || '0') + decimalPart, 10);
  } else {
    // Sin decimal explícito → tratar como pesos enteros.
    parsedCents = parseInt(digits, 10) * 100;
  }

  if (Number.isNaN(parsedCents)) return null;
  return isNegative ? -parsedCents : parsedCents;
}

// ─── Componente ──────────────────────────────────────────────────────

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

    // Sync con value externo cuando cambia desde fuera (ej: reset del form).
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
      // Permitir combos con modifiers (copy, paste, select, navigation).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Permitir teclas de navegación / sistema.
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
      // Cualquier otra tecla: ignorada (preventDefault arriba).
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text');
      const parsedCents = parsePastedToCents(pasted, allowNegative);
      if (parsedCents !== null) commitCents(parsedCents);
    }

    function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
      // Selección completa para que tipear empiece de cero (UX estándar AR).
      e.target.select();
      onFocus?.(e);
    }

    const display = formatCents(cents);

    return (
      <div className={cn('relative flex items-center', className)}>
        {currencySymbol !== null && (
          <span className="absolute left-3 text-muted-foreground pointer-events-none select-none text-sm">
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
          // Controlled: ignoramos onChange nativo. La actualización viene de keydown/paste.
          onChange={() => { /* noop */ }}
          placeholder={placeholder}
          id={id}
          name={name}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedby}
          required={required}
          data-testid={testId}
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'tabular-nums text-right',
            currencySymbol !== null && 'pl-7',
          )}
        />
      </div>
    );
  },
);
