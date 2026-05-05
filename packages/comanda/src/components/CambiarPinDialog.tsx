import { useEffect, useState } from 'react';
import { db } from '@/lib/supabase';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NumericPad } from '@/components/NumericPad';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  empleadoId: string;
}

type Step = 'actual' | 'nuevo' | 'confirmar';

const STEP_LABEL: Record<Step, string> = {
  actual:    'Ingresá tu PIN actual',
  nuevo:     'Elegí un PIN nuevo',
  confirmar: 'Confirmá el PIN nuevo',
};

// Dialog para que un empleado cambie su propio PIN. Verifica el PIN actual
// con bcrypt server-side via fn_cambiar_pin_pos. Tres pasos: actual → nuevo
// → confirmar. Si los PINs nuevo/confirmar no coinciden, vuelve al paso
// "nuevo" sin perder el PIN actual ya validado.
export function CambiarPinDialog({ open, onOpenChange, empleadoId }: Props) {
  const [step, setStep] = useState<Step>('actual');
  const [pinActual, setPinActual] = useState('');
  const [pinNuevo, setPinNuevo] = useState('');
  const [pinConfirmar, setPinConfirmar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset cuando se abre el dialog
  useEffect(() => {
    if (open) {
      setStep('actual');
      setPinActual('');
      setPinNuevo('');
      setPinConfirmar('');
      setError(null);
    }
  }, [open]);

  // Auto-avance al paso siguiente cuando se llega a 4 dígitos
  useEffect(() => {
    if (saving) return;
    if (step === 'actual' && pinActual.length === 4) setStep('nuevo');
    else if (step === 'nuevo' && pinNuevo.length === 4) setStep('confirmar');
    else if (step === 'confirmar' && pinConfirmar.length === 4) {
      void commit();
    }
  }, [pinActual, pinNuevo, pinConfirmar, step, saving]);

  async function commit() {
    if (pinNuevo !== pinConfirmar) {
      setError('Los PIN nuevos no coinciden. Probá de nuevo.');
      setPinNuevo('');
      setPinConfirmar('');
      setStep('nuevo');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await db.rpc('fn_cambiar_pin_pos', {
      p_empleado_id: empleadoId,
      p_pin_actual: pinActual,
      p_pin_nuevo: pinNuevo,
    });
    setSaving(false);
    if (err) {
      const msg = err.message ?? '';
      if (msg.includes('PIN_ACTUAL_INCORRECTO')) {
        setError('PIN actual incorrecto.');
        setPinActual('');
        setPinNuevo('');
        setPinConfirmar('');
        setStep('actual');
      } else if (msg.includes('PIN_INVALIDO')) {
        setError('El PIN debe ser de 4 dígitos.');
        setPinNuevo('');
        setPinConfirmar('');
        setStep('nuevo');
      } else {
        setError(msg || 'No se pudo cambiar el PIN');
      }
      return;
    }
    onOpenChange(false);
  }

  const currentPin =
    step === 'actual' ? pinActual : step === 'nuevo' ? pinNuevo : pinConfirmar;
  const setCurrentPin =
    step === 'actual' ? setPinActual : step === 'nuevo' ? setPinNuevo : setPinConfirmar;

  function handleDigit(d: string) {
    if (saving || currentPin.length >= 4) return;
    setCurrentPin(currentPin + d);
    setError(null);
  }
  function handleDelete() {
    setCurrentPin(currentPin.slice(0, -1));
    setError(null);
  }
  function handleClear() {
    setCurrentPin('');
    setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cambiar PIN</DialogTitle>
          <DialogDescription>{STEP_LABEL[step]}</DialogDescription>
        </DialogHeader>

        {/* PIN dots */}
        <div className="flex justify-center gap-3 my-2" aria-live="polite">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'h-4 w-4 rounded-full border-2 transition-colors',
                currentPin.length > i
                  ? 'bg-primary border-primary'
                  : 'border-border-strong bg-transparent',
              )}
            />
          ))}
        </div>

        {error && (
          <div className="text-center text-sm text-destructive font-medium">
            {error}
          </div>
        )}

        <NumericPad
          onDigit={handleDigit}
          onDelete={handleDelete}
          onClear={handleClear}
          disabled={saving}
        />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
