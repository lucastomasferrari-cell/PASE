import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { verificarPinManager } from '@/services/overridesService';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { NumericPad } from '@/components/NumericPad';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Texto descriptivo de qué se va a hacer (ej: "Anular item: Hamburguesa $5.000")
  accion: string;
  descripcion: string;
  // Callback cuando el manager ya autorizó: recibe managerId + motivo + ip.
  onAuthorized: (args: { managerId: string; motivo: string; ip: string | null }) => Promise<void> | void;
  // Si necesitamos capturar IP para audit
  captureIp?: boolean;
}

const MAX_INTENTOS = 3;
const MOTIVO_MIN = 10;

// Dialog reusable que pide PIN del manager + motivo, verifica con
// fn_verificar_pin_pos filtrando rol_pos in ('manager','dueno'),
// y si OK ejecuta onAuthorized. Captura IP via ipify (timeout 2s, fallback NULL).
export function ManagerOverrideDialog({
  open, onOpenChange, accion, descripcion, onAuthorized, captureIp = true,
}: Props) {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [pin, setPin] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [intentos, setIntentos] = useState(0);
  const [verificando, setVerificando] = useState(false);

  useEffect(() => {
    if (open) {
      setPin(''); setMotivo(''); setError(null); setIntentos(0); setVerificando(false);
    }
  }, [open]);

  // Workaround radix-ui issue #1241 (ver CambiarPinDialog): si este dialog
  // se abre desde un DropdownMenu o Popover, radix puede dejar
  // `pointer-events: none` en <body>, bloqueando los clicks del NumericPad.
  useEffect(() => {
    if (open) {
      document.body.style.pointerEvents = 'auto';
    }
  }, [open]);

  async function confirmar() {
    if (motivo.trim().length < MOTIVO_MIN) {
      setError(`El motivo debe tener al menos ${MOTIVO_MIN} caracteres`);
      return;
    }
    if (pin.length !== 4) {
      setError('PIN del manager incompleto');
      return;
    }
    if (localId === null) {
      setError('Sin local activo');
      return;
    }
    setVerificando(true);
    setError(null);
    const { empleadoId, error: vErr } = await verificarPinManager(localId, pin);
    if (vErr || !empleadoId) {
      const proximoIntento = intentos + 1;
      setIntentos(proximoIntento);
      setVerificando(false);
      setPin('');
      if (proximoIntento >= MAX_INTENTOS) {
        setError('Máximo de intentos alcanzado. Cancelando.');
        setTimeout(() => onOpenChange(false), 1500);
      } else {
        setError(`${vErr ?? 'PIN incorrecto'} (intento ${proximoIntento}/${MAX_INTENTOS})`);
      }
      return;
    }

    let ip: string | null = null;
    if (captureIp) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = (await r.json()) as { ip?: string };
          ip = j.ip ?? null;
        }
      } catch { /* fallback NULL */ }
    }

    try {
      await onAuthorized({ managerId: empleadoId, motivo: motivo.trim(), ip });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error ejecutando la acción');
    } finally {
      setVerificando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-warning/10">
              <ShieldAlert className="h-5 w-5 text-warning" />
            </div>
            <div>
              <DialogTitle>Autorización requerida</DialogTitle>
              <DialogDescription>{accion}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-md bg-muted p-3 text-sm">{descripcion}</div>

        <div className="space-y-2">
          <Label htmlFor="motivo">Motivo (requerido, mín. {MOTIVO_MIN} chars)</Label>
          <Textarea
            id="motivo"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={2}
            placeholder="Cliente reclamó… / Error de carga… / etc."
          />
        </div>

        <div className="space-y-2">
          <Label>PIN del manager</Label>
          <div className="flex justify-center gap-3 my-2" aria-live="polite">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={cn(
                  'h-4 w-4 rounded-full border-2 transition-colors',
                  pin.length > i ? 'bg-primary border-primary' : 'border-border-strong bg-transparent',
                )}
              />
            ))}
          </div>
          <NumericPad
            onDigit={(d) => { if (pin.length < 4) { setPin(pin + d); setError(null); } }}
            onDelete={() => setPin(pin.slice(0, -1))}
            onClear={() => setPin('')}
            disabled={verificando}
          />
        </div>

        {error && (
          <div className="text-center text-sm text-destructive font-medium">{error}</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={verificando}>
            Cancelar
          </Button>
          <Button
            variant="warning"
            onClick={confirmar}
            disabled={verificando || pin.length !== 4 || motivo.trim().length < MOTIVO_MIN}
          >
            {verificando ? 'Verificando…' : 'Autorizar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
