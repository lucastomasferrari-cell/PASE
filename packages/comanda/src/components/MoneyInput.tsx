import { CurrencyInput } from './CurrencyInput';

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

// Wrapper de retrocompatibilidad: MoneyInput se usa en 9 callers
// (Caja, MovimientoCajaDialog, PaymentDialog, ItemForm,
// ModificadoresTab, SettingsLocal). Sprint CurrencyInput reemplazó
// la implementación interna por currency mask sin formato libre,
// manteniendo la signature original.
//
// Para nuevos callers, importar directamente CurrencyInput.
// Este wrapper se elimina cuando todos los callers se migren.
export function MoneyInput({
  value, onChange, disabled, autoFocus, placeholder, ariaLabel, className, onBlur,
}: MoneyInputProps) {
  return (
    <CurrencyInput
      value={value}
      onChange={onChange}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel ?? 'monto'}
      className={className}
      // El viejo onBlur no recibía evento. Adaptamos para preservar la API.
      onBlur={onBlur ? () => onBlur() : undefined}
      // currencySymbol={null} si querés sin símbolo, pero el viejo no lo
      // mostraba — por compat NO mostramos símbolo en MoneyInput.
      currencySymbol={null}
    />
  );
}
