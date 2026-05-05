import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { listLocalesAccesibles, type LocalSimple } from '../../services/configService';
import { useEffect } from 'react';
import { NumericPad } from '../../components/NumericPad';

// Pantalla de bloqueo POS. Muestra el pad de 4 dígitos. Si OK, popula
// AuthPosContext y la app POS se desbloquea.
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

  async function trySubmit() {
    if (localId === null) { setError('Elegí un local primero'); return; }
    if (pin.length !== 4) return;
    setTrying(true); setError(null);
    const res = await loginPin(localId, pin);
    setTrying(false);
    if (!res.ok) {
      setError(res.error ?? 'PIN incorrecto');
      setPin('');
    }
  }

  return (
    <div style={page}>
      <div style={card}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>COMANDA</h1>
        <p style={{ margin: '4px 0 16px', fontSize: 13, color: '#6B7280' }}>
          Ingresá tu PIN de 4 dígitos
        </p>

        {locales.length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: '#374151' }}>Local</label>
            <select
              value={localId ?? ''}
              onChange={(e) => setLocalActivo(Number(e.target.value))}
              style={{ display: 'block', marginTop: 4, padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%' }}
            >
              <option value="">— elegir —</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        )}

        <NumericPad
          value={pin}
          onChange={(v) => { setPin(v); setError(null); }}
          onSubmit={trySubmit}
          maxLength={4}
          showDots
          ariaLabel="PIN POS"
          disabled={trying}
        />

        {error && <div style={errBox}>{error}</div>}

        <p style={{ marginTop: 16, fontSize: 11, color: '#9CA3AF', textAlign: 'center' }}>
          Si no tenés PIN, andá a Settings → Empleados POS desde otro dispositivo.
        </p>
      </div>
    </div>
  );
}

const page: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#111827', fontFamily: 'system-ui' };
const card: React.CSSProperties = { background: '#FFFFFF', borderRadius: 12, padding: 32, maxWidth: 360, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' };
const errBox: React.CSSProperties = { marginTop: 12, padding: 8, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13 };
