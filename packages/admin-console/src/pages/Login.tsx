import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { signIn } from '@/lib/auth';

interface Props {
  reason?: string;   // mensaje opcional cuando viene de un estado forbidden
}

export function Login({ reason }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    const { error: errMsg } = await signIn(email, password);
    if (errMsg) {
      setError(errMsg);
      setLoading(false);
    }
    // En éxito el AuthState pasa a "authenticated" via onAuthStateChange.
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-admin-bg relative overflow-hidden">
      <div className="scanline" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(117,170,219,0.10),transparent_60%)]" />

      <form onSubmit={onSubmit} className="relative w-full max-w-md">
        <div className="flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-admin-muted mb-2 px-1">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-admin-gold glow-dot animate-pulse" />
            <span className="text-admin-gold">System · Restricted</span>
          </div>
          <span>CONSOLE.SYS</span>
        </div>

        <div className="bg-admin-surface border border-admin-border rounded overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.5)]">
          <div className="px-6 pt-6 pb-4 border-b border-admin-border">
            <div className="mono flex items-baseline gap-2">
              <span className="text-admin-accent opacity-70">root@admin:~#</span>
              <div className="text-2xl font-bold tracking-tight">
                console<span className="text-admin-gold">.</span><span className="text-admin-muted font-light text-lg">os</span>
              </div>
            </div>
            <p className="text-sm text-admin-muted mt-2">Acceso restringido a superadmins del ecosistema.</p>
          </div>

          <div className="px-6 py-5 space-y-4">
            {reason && (
              <div className="p-3 rounded border-l-2 border-admin-warn bg-admin-warn/10 mono text-[11px] text-admin-warn">
                {reason}
              </div>
            )}
            <div>
              <label className="label-sys block mb-1.5">Email</label>
              <input
                type="text"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="superadmin@empresa.com"
                autoFocus
                className="w-full h-10 px-3 mono text-sm text-admin-text placeholder:text-admin-muted/60"
              />
            </div>
            <div>
              <label className="label-sys block mb-1.5">Contraseña</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full h-10 px-3 mono text-sm text-admin-text placeholder:text-admin-muted/60"
              />
            </div>
            {error && <div className="mono text-[11px] text-admin-danger">{error}</div>}
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-[3px] mono uppercase tracking-[0.2em] text-xs text-admin-accent border border-admin-accent/20 hover:bg-admin-accent/10 hover:border-admin-accent/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Autenticando…' : 'Ejecutar ingreso'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          <div className="px-6 pb-4 flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-admin-muted/70">
            <span>ECOSISTEMA COCINA</span>
            <span>ROOT · CONTROL PLANE</span>
          </div>
        </div>
      </form>
    </div>
  );
}
