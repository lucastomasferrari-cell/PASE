import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Delete, LayoutGrid, LogOut } from 'lucide-react';
import { useAuth, puedeAccederAdmin } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
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
// Tap targets tablet-friendly: h-14 = 56px (por encima del mínimo Material
// Design de 48px, muy por encima del mínimo iOS HIG de 44px). En tablet los
// dedos son gruesos y el error de tap es alto — subir de 44 a 56 baja mucho
// los mistap sin sacrificar layout.
const keyCls =
  'h-14 rounded-lg border border-[#D0DCEA] dark:border-[#3F4D6E] '
  + 'text-xl font-medium text-[#1A3A5E] dark:text-[#F0F4F8] '
  + 'hover:bg-[#EAF3FB] dark:hover:bg-[#1E3155] active:scale-[0.97] '
  + 'transition disabled:opacity-50 grid place-items-center select-none';

export function PinPad() {
  const { user } = useAuth();
  const { loginPin } = useAuthPos();
  const navigate = useNavigate();
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- trySubmit referenciada antes de declarar (hoisting); no debe re-crear el effect.
  }, [pin, trying, localId]);

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

  // Cierra la sesión del DISPOSITIVO (Supabase). El AuthGate detecta que ya no
  // hay sesión y manda a /login. Sirve si es la cuenta equivocada.
  async function cerrarSesion() {
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-[#EFF3F8] dark:bg-[#0C1220]">
      <div className="relative w-full max-w-[320px] rounded-2xl border border-[#E0EAF4] dark:border-[#2A3550] bg-white dark:bg-[#1A2540] shadow-[0_2px_4px_rgba(26,58,94,0.04),0_4px_16px_rgba(26,58,94,0.08)] p-6">
        <div className="absolute top-3 right-3">
          <ThemeToggle />
        </div>

        {/* Marca */}
        <div className="mb-4">
          <div className="text-[22px] leading-none font-medium tracking-tight text-[#1A3A5E] dark:text-[#F0F4F8]">
            comanda<span className="text-[#F5C518]">.</span>
          </div>
          <p className="mt-1.5 text-xs text-[#6E8CAB] dark:text-[#93A8C2]">
            Ingresá tu PIN de 4 dígitos.
          </p>
        </div>

        {/* Selector de local */}
        {locales.length > 1 && (
          <div className="mb-4">
            <label className={labelCls}>Local</label>
            <Select
              value={localId !== null ? String(localId) : ''}
              onValueChange={(v) => setLocalActivo(Number(v))}
            >
              <SelectTrigger className="h-10 text-sm rounded-lg border-[#D0DCEA] dark:border-[#3F4D6E] bg-white dark:bg-[#0C1220]">
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
        <div className="flex justify-center gap-3 my-5" aria-live="polite">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'h-3.5 w-3.5 rounded-full border-2 transition-colors',
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
        <div className="grid grid-cols-3 gap-2">
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

        {/* Salidas: no todos vienen a operar el POS. El link al panel admin
            solo aparece si el user logueado tiene acceso admin explícito
            (no basta con rol_pos='admin' — ese es solo para operaciones POS). */}
        <div className={cn(
          'mt-5 pt-4 border-t border-[#E0EAF4] dark:border-[#2A3550] flex items-center gap-2',
          puedeAccederAdmin(user) ? 'justify-between' : 'justify-end',
        )}>
          {puedeAccederAdmin(user) && (
            <button type="button" onClick={() => navigate('/reportes/dashboard')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1A3A5E] dark:text-[#93A8C2] hover:text-[#75AADB] transition-colors">
              <LayoutGrid className="h-3.5 w-3.5" /> Panel de administración
            </button>
          )}
          <button type="button" onClick={() => void cerrarSesion()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6E8CAB] dark:text-[#93A8C2] hover:text-[#C0392B] transition-colors">
            <LogOut className="h-3.5 w-3.5" /> Cerrar sesión
          </button>
        </div>

        <p className="text-[11px] text-[#6E8CAB] dark:text-[#93A8C2] text-center mt-3">
          ¿No tenés PIN? Pedíselo al encargado, o crealo en Configuración → Empleados.
        </p>
      </div>
    </div>
  );
}
