import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../lib/supabase';
import { ThemeToggle } from '@/components/ThemeToggle';

// Permite email completo (con @) o solo username (concatena @pase.local).
const EMAIL_O_USER_RE = /^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/;

function normalizarEmail(input: string): string {
  const s = input.trim();
  return s.includes('@') ? s : `${s}@pase.local`;
}

// Login unificado del ecosistema Cocina (celeste PASE + toggle dark/light).
const labelCls = 'block text-sm font-medium text-[#1A3A5E] dark:text-[#F0F4F8] mb-1.5';
const inputCls =
  'w-full h-11 rounded-lg border border-[#D0DCEA] dark:border-[#3F4D6E] '
  + 'bg-white dark:bg-[#0C1220] px-3.5 text-sm text-[#1A3A5E] dark:text-[#F0F4F8] '
  + 'placeholder:text-[#9DB2CC] dark:placeholder:text-[#6E8CAB] outline-none '
  + 'focus:border-[#75AADB] focus:ring-2 focus:ring-[#75AADB]/25 transition';
const btnCls =
  'w-full h-11 rounded-lg bg-[#75AADB] hover:bg-[#5f97cc] active:bg-[#5589bd] '
  + 'text-white text-sm font-medium transition-colors disabled:opacity-60';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_O_USER_RE.test(email.trim())) {
      setError('Email o usuario inválido');
      return;
    }
    if (!password) {
      setError('La contraseña no puede estar vacía');
      return;
    }
    setError(null);
    setLoading(true);
    let err: { message: string } | null = null;
    try {
      const res = await db.auth.signInWithPassword({
        email: normalizarEmail(email),
        password,
      });
      err = res.error;
    } catch (caught) {
      err = { message: caught instanceof Error ? caught.message : String(caught) };
    }
    setLoading(false);
    if (err) {
      setError(traducirError(err.message));
      return;
    }
    // Volver a la zona desde donde vinimos (botones Admin↔POS pasan ?next=).
    // Solo rutas internas (empiezan con "/") por seguridad.
    const next = new URLSearchParams(window.location.search).get('next');
    navigate(next && next.startsWith('/') ? next : '/catalogo', { replace: true });
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-[#EFF3F8] dark:bg-[#0C1220]">
      <div className="relative w-full max-w-[400px] rounded-2xl border border-[#E0EAF4] dark:border-[#2A3550] bg-white dark:bg-[#1A2540] shadow-[0_2px_4px_rgba(26,58,94,0.04),0_4px_16px_rgba(26,58,94,0.08)] p-8">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>

        <div className="mb-6">
          <div className="text-[26px] leading-none font-medium tracking-tight text-[#1A3A5E] dark:text-[#F0F4F8]">
            comanda<span className="text-[#F5C518]">.</span>
          </div>
          <p className="mt-2 text-xs text-[#6E8CAB] dark:text-[#93A8C2]">
            Iniciá sesión con tu usuario y contraseña.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className={labelCls}>Usuario o email</label>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              autoComplete="username"
              required
              placeholder="dueno (o tu@email.com)"
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="password" className={labelCls}>Contraseña</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="••••••••"
              className={inputCls}
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-[#FDECEC] dark:bg-[#3A1A1A] text-[#C0392B] text-sm">
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className={btnCls}>
            {loading ? 'Iniciando sesión…' : 'Iniciar sesión'}
          </button>
        </form>
      </div>
    </div>
  );
}

function traducirError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid_credentials')) {
    return 'Email o contraseña incorrectos.';
  }
  if (m.includes('email not confirmed')) {
    return 'El email todavía no fue confirmado.';
  }
  if (m.includes('too many requests')) {
    return 'Demasiados intentos. Esperá unos minutos.';
  }
  // Errores de red (fetch falla por conexión / servidor caído / CORS).
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('network request failed')) {
    return 'No se pudo conectar. Revisá tu conexión a internet e intentá de nuevo.';
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return 'La conexión tardó demasiado. Probá de nuevo.';
  }
  // Fallback en español — nunca mostramos el error crudo en inglés.
  return 'No pudimos iniciar sesión. Probá de nuevo en unos segundos.';
}
