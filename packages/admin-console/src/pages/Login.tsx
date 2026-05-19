import { useState, type FormEvent } from 'react';
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
    <div className="min-h-screen flex items-center justify-center bg-admin-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-xs uppercase tracking-wider text-admin-muted">PASE</div>
          <div className="text-2xl font-semibold text-admin-text mt-1">Admin Console</div>
          <div className="text-xs text-admin-muted mt-2">Acceso restringido a superadmins.</div>
        </div>

        {reason && (
          <div className="mb-4 p-3 rounded border border-admin-warn/40 bg-admin-warn/10 text-xs text-admin-warn">
            {reason}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-admin-muted mb-1.5">Email</label>
            <input
              type="text"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded bg-admin-surface border border-admin-border text-admin-text text-sm focus:outline-none focus:border-admin-accent"
            />
          </div>
          <div>
            <label className="block text-xs text-admin-muted mb-1.5">Contraseña</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded bg-admin-surface border border-admin-border text-admin-text text-sm focus:outline-none focus:border-admin-accent"
            />
          </div>
          {error && (
            <div className="text-xs text-admin-danger">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2 rounded bg-admin-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
