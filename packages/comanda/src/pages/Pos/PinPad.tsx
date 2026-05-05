import { useEffect, useState } from 'react';
import { Lock, Delete } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/lib/utils';

export function PinPad() {
  const { user } = useAuth();
  const { loginPin } = useAuthPos();
  const [localId, setLocalActivo] = useLocalActivo(user);
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    listLocalesAccesibles().then((res) => setLocales(res.data));
  }, []);

  // Auto-submit cuando llega a 4 dígitos
  useEffect(() => {
    if (pin.length === 4 && !trying && localId !== null) {
      void trySubmit();
    }
  }, [pin, trying, localId]); // trySubmit referenciada antes de declarar — OK por hoisting de funciones nombradas

  // Soporte teclado físico
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (trying) return;
      if (e.key >= '0' && e.key <= '9' && pin.length < 4) {
        setPin((p) => p + e.key);
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        setPin((p) => p.slice(0, -1));
        setError(null);
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pin.length, trying]);

  async function trySubmit() {
    if (localId === null) {
      setError('Elegí un local primero');
      return;
    }
    if (pin.length !== 4) return;
    setTrying(true);
    setError(null);
    const res = await loginPin(localId, pin);
    setTrying(false);
    if (!res.ok) {
      setError(res.error ?? 'PIN incorrecto');
      setPin('');
    }
  }

  function handleDigit(digit: string) {
    if (pin.length < 4 && !trying) {
      setPin(pin + digit);
      setError(null);
    }
  }

  function handleDelete() {
    setPin((p) => p.slice(0, -1));
    setError(null);
  }

  function handleClear() {
    setPin('');
    setError(null);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="p-8">
          {/* Header con marca */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
              <Lock className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">COMANDA</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Ingresá tu PIN de 4 dígitos
            </p>
          </div>

          {/* Selector de local */}
          {locales.length > 1 && (
            <div className="mb-6">
              <Label className="text-sm font-medium mb-2 block">Local</Label>
              <Select
                value={localId !== null ? String(localId) : ''}
                onValueChange={(v) => setLocalActivo(Number(v))}
              >
                <SelectTrigger className="h-12 text-base">
                  <SelectValue placeholder="Elegir local…" />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((local) => (
                    <SelectItem
                      key={local.id}
                      value={String(local.id)}
                      className="text-base"
                    >
                      {local.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* PIN dots */}
          <div className="flex justify-center gap-3 mb-8" aria-live="polite">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={cn(
                  'h-4 w-4 rounded-full border-2 transition-colors',
                  pin.length > i
                    ? 'bg-primary border-primary'
                    : 'border-border-strong bg-transparent',
                )}
              />
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 text-center text-sm text-destructive font-medium">
              {error}
            </div>
          )}

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <Button
                key={digit}
                variant="outline"
                size="xl"
                className="h-16 text-2xl font-medium"
                disabled={trying}
                onClick={() => handleDigit(digit)}
              >
                {digit}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="xl"
              className="h-16 text-sm font-medium text-muted-foreground"
              disabled={trying}
              onClick={handleClear}
            >
              Borrar
            </Button>
            <Button
              variant="outline"
              size="xl"
              className="h-16 text-2xl font-medium"
              disabled={trying}
              onClick={() => handleDigit('0')}
            >
              0
            </Button>
            <Button
              variant="ghost"
              size="xl"
              className="h-16"
              disabled={trying}
              onClick={handleDelete}
            >
              <Delete className="h-6 w-6" />
              <span className="sr-only">Borrar último dígito</span>
            </Button>
          </div>

          {/* Helper text */}
          <p className="text-xs text-muted-foreground text-center mt-6">
            Si no tenés PIN, andá a Settings → Empleados POS desde otro dispositivo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
