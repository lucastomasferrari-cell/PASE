import { useEffect, useState } from 'react';
import { Delete } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/lib/utils';

// Login unificado del ecosistema Cocina (celeste PASE + toggle dark/light).
// Mismos tamaños/caja/tipografía que PASE/MESA/Habitué; el POS por detrás
// conserva su índigo/navy — sólo esta pantalla de entrada usa el celeste.
const labelCls = 'block text-sm font-medium text-[#1A3A5E] dark:text-[#F0F4F8] mb-1.5';
const keyCls =
  'h-14 rounded-lg border border-[#D0DCEA] dark:border-[#3F4D6E] '
  + 'text-xl font-medium text-[#1A3A5E] dark:text-[#F0F4F8] '
  + 'hover:bg-[#EAF3FB] dark:hover:bg-[#1E3155] active:scale-[0.97] '
  + 'transition disabled:opacity-50 grid place-items-center select-none';

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
    <div className="min-h-screen grid place-items-center px-4 bg-[#EFF3F8] dark:bg-[#0C1220]">
      <div className="relative w-full max-w-[400px] rounded-2xl border border-[#E0EAF4] dark:border-[#2A3550] bg-white dark:bg-[#1A2540] shadow-[0_2px_4px_rgba(26,58,94,0.04),0_4px_16px_rgba(26,58,94,0.08)] p-8">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>

        {/* Marca */}
        <div className="mb-6">
          <div className="text-[26px] leading-none font-medium tracking-tight text-[#1A3A5E] dark:text-[#F0F4F8]">
            comanda<span className="text-[#F5C518]">.</span>
          </div>
          <p className="mt-2 text-xs text-[#6E8CAB] dark:text-[#93A8C2]">
            Ingresá tu PIN de 4 dígitos.
          </p>
        </div>

        {/* Selector de local */}
        {locales.length > 1 && (
          <div className="mb-5">
            <label className={labelCls}>Local</label>
            <Select
              value={localId !== null ? String(localId) : ''}
              onValueChange={(v) => setLocalActivo(Number(v))}
            >
              <SelectTrigger className="h-11 text-sm rounded-lg border-[#D0DCEA] dark:border-[#3F4D6E] bg-white dark:bg-[#0C1220]">
                <SelectValue placeholder="Elegir local…" />
              </SelectTrigger>
              <SelectContent>
                {locales.map((local) => (
                  <SelectItem key={local.id} value={String(local.id)} className="text-sm">
                    {local.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* PIN dots */}
        <div className="flex justify-center gap-3 my-7" aria-live="polite">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'h-4 w-4 rounded-full border-2 transition-colors',
                pin.length > i
                  ? 'bg-[#75AADB] border-[#75AADB]'
                  : 'border-[#D0DCEA] dark:border-[#3F4D6E] bg-transparent',
              )}
            />
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 text-center text-sm text-[#C0392B] font-medium">
            {error}
          </div>
        )}

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button key={digit} type="button" className={keyCls} disabled={trying}
              onClick={() => handleDigit(digit)}>
              {digit}
            </button>
          ))}
          <button type="button" disabled={trying} onClick={handleClear}
            className={cn(keyCls, 'text-sm text-[#6E8CAB] dark:text-[#93A8C2]')}>
            Borrar
          </button>
          <button type="button" className={keyCls} disabled={trying}
            onClick={() => handleDigit('0')}>
            0
          </button>
          <button type="button" disabled={trying} onClick={handleDelete}
            className={cn(keyCls, 'text-[#6E8CAB] dark:text-[#93A8C2]')}>
            <Delete className="h-6 w-6" />
            <span className="sr-only">Borrar último dígito</span>
          </button>
        </div>

        <p className="text-xs text-[#6E8CAB] dark:text-[#93A8C2] text-center mt-6">
          Si no tenés PIN, andá a Settings → Empleados POS desde otro dispositivo.
        </p>
      </div>
    </div>
  );
}
