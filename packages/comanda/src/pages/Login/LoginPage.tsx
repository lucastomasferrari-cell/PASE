import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../lib/supabase';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError('Email inválido');
      return;
    }
    if (!password) {
      setError('La contraseña no puede estar vacía');
      return;
    }
    setError(null);
    setLoading(true);
    const { error: err } = await db.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (err) {
      // Supabase devuelve mensajes en inglés. Traducimos los más comunes.
      setError(traducirError(err.message));
      return;
    }
    navigate('/catalogo', { replace: true });
  }

  return (
    <div style={page}>
      <form onSubmit={onSubmit} style={card}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>COMANDA</h1>
        <p style={{ margin: '4px 0 24px', fontSize: 13, color: '#6B7280' }}>
          Iniciá sesión con tu email y contraseña de PASE.
        </p>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            autoComplete="email"
            required
            placeholder="tu@email.com"
            style={input}
          />
        </Field>

        <Field label="Contraseña">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={input}
          />
        </Field>

        {error && <div style={errBox}>{error}</div>}

        <button type="submit" disabled={loading} style={loading ? btnDisabled : btnPrimary}>
          {loading ? 'Iniciando sesión…' : 'Iniciar sesión'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14, fontSize: 13 }}>
      <div style={{ marginBottom: 4, fontWeight: 500, color: '#374151' }}>{label}</div>
      {children}
    </label>
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
  return msg;
}

const page: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: '#F9FAFB',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const card: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E5E7EB',
  borderRadius: 8,
  padding: 32,
  maxWidth: 400,
  width: '100%',
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
};

const input: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #D1D5DB',
  borderRadius: 6,
  fontSize: 14,
  width: '100%',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const btnPrimary: React.CSSProperties = {
  marginTop: 8,
  padding: '10px 16px',
  border: 'none',
  borderRadius: 6,
  background: '#2563EB',
  color: '#FFFFFF',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  width: '100%',
};

const btnDisabled: React.CSSProperties = {
  ...btnPrimary,
  background: '#9CA3AF',
  cursor: 'wait',
};

const errBox: React.CSSProperties = {
  padding: 10,
  background: '#FEE2E2',
  color: '#991B1B',
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 12,
};
