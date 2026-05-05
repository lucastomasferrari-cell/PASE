import { Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  onClear?: () => void;
  disabled?: boolean;
}

// Pad numérico genérico — usado por SettingsEmpleados/PinDialog para asignar
// PINs y por cualquier flujo que necesite captura numérica.
// Para la versión "captura de PIN al login" ver PinPad.tsx.
export function NumericPad({ onDigit, onDelete, onClear, disabled }: Props) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
        <Button
          key={digit}
          type="button"
          variant="outline"
          size="xl"
          className="h-16 text-2xl font-medium"
          disabled={disabled}
          onClick={() => onDigit(digit)}
        >
          {digit}
        </Button>
      ))}
      {onClear ? (
        <Button
          type="button"
          variant="ghost"
          size="xl"
          className="h-16 text-sm font-medium text-muted-foreground"
          disabled={disabled}
          onClick={onClear}
        >
          Borrar
        </Button>
      ) : (
        <div />
      )}
      <Button
        type="button"
        variant="outline"
        size="xl"
        className="h-16 text-2xl font-medium"
        disabled={disabled}
        onClick={() => onDigit('0')}
      >
        0
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xl"
        className="h-16"
        disabled={disabled}
        onClick={onDelete}
        aria-label="Borrar último dígito"
      >
        <Delete className="h-6 w-6" />
      </Button>
    </div>
  );
}
