import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { abrirTurno, getTurnoAbierto } from '../../services/turnosCajaService';
import { MoneyInput } from '../../components/MoneyInput';

export function CajaAbrir() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [montoInicial, setMontoInicial] = useState(0);
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [chequeando, setChequeando] = useState(true);

  // Si ya hay turno abierto, mandar a estado
  useEffect(() => {
    if (localId === null) return;
    getTurnoAbierto(localId).then((res) => {
      if (res.data) navigate('/caja', { replace: true });
      setChequeando(false);
    });
  }, [localId, navigate]);

  if (chequeando) return <Centered>Verificando turno…</Centered>;
  if (!empleado) return <Centered>Necesitás iniciar sesión POS primero.</Centered>;
  if (localId === null) return <Centered>Sin local activo.</Centered>;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!empleado) return;
    if (localId === null) return;
    setSaving(true); setError(null);
    const { turnoId, error: err } = await abrirTurno(localId, empleado.id, montoInicial, notas.trim() || null);
    setSaving(false);
    if (err || !turnoId) { setError(err ?? 'Error desconocido'); return; }
    navigate('/caja', { replace: true });
  }

  return (
    <div style={page}>
      <form onSubmit={onSubmit} style={card}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Abrir caja</h2>
        <p style={{ margin: '4px 0 20px', fontSize: 13, color: '#6B7280' }}>
          Cajero: {empleado.nombre}
        </p>

        <Field label="Monto inicial (efectivo en caja)">
          <MoneyInput value={montoInicial} onChange={setMontoInicial} autoFocus />
        </Field>

        <Field label="Notas (opcional)">
          <textarea
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            rows={3}
            style={{ ...input, minHeight: 60 }}
          />
        </Field>

        {error && <div style={errBox}>{error}</div>}

        <button type="submit" disabled={saving} style={btnPrimary}>
          {saving ? 'Abriendo…' : 'Abrir caja'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
      <div style={{ marginBottom: 4, fontWeight: 500, color: '#374151' }}>{label}</div>
      {children}
    </label>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontFamily: 'system-ui' }}>{children}</div>;
}

const page: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#F9FAFB', fontFamily: 'system-ui' };
const card: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 32, maxWidth: 420, width: '100%', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB' };
const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' };
const btnPrimary: React.CSSProperties = { marginTop: 4, padding: '10px 16px', border: 'none', borderRadius: 6, background: '#10B981', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500, width: '100%' };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
