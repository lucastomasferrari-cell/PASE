import { useEffect, useState } from 'react';
import { setPin } from '../../services/empleadosService';
import { NumericPad } from '@/components/NumericPad';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface Props {
  empleadoId: string;
  empleadoNombre: string;
  onClose: () => void;
  onDone: () => void;
}

export function PinDialog({ empleadoId, empleadoNombre, onClose, onDone }: Props) {
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Auto-avance step 1 → step 2 al llegar a 4 dígitos
  useEffect(() => {
    if (step === 1 && pin1.length === 4) {
      setStep(2);
    }
  }, [pin1, step]);

  // Auto-commit al llegar a 4 dígitos en step 2
  useEffect(() => {
    if (step === 2 && pin2.length === 4 && !saving) {
      void commit();
    }
  }, [pin2, step, saving]);

  async function commit() {
    if (pin1.length !== 4) { setError('PIN debe ser de 4 dígitos'); return; }
    if (pin1 !== pin2) {
      setError('Los PIN no coinciden. Volvé a empezar.');
      setPin1(''); setPin2(''); setStep(1);
      return;
    }
    setSaving(true); setError(null);
    const { error: err } = await setPin(empleadoId, pin1);
    setSaving(false);
    if (err) { setError(err); return; }
    onDone();
  }

  const currentPin = step === 1 ? pin1 : pin2;
  const setCurrentPin = step === 1 ? setPin1 : setPin2;

  function handleDigit(d: string) {
    if (saving) return;
    if (currentPin.length < 4) {
      setCurrentPin(currentPin + d);
      setError(null);
    }
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Asignar PIN</DialogTitle>
          <DialogDescription>
            {empleadoNombre} · {step === 1 ? 'Ingresá un PIN de 4 dígitos' : 'Confirmá el PIN'}
          </DialogDescription>
        </DialogHeader>

        {/* PIN dots */}
        <div className="flex justify-center gap-3 my-4" aria-live="polite">
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
          <div className="text-center text-sm text-destructive font-medium mb-2">
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
          {step === 2 && !saving && (
            <Button
              variant="outline"
              onClick={() => { setStep(1); setPin1(''); setPin2(''); setError(null); }}
            >
              Volver
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
