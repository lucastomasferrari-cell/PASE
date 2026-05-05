import { useState } from 'react';
import { NumericPad } from '../../components/NumericPad';
import { setPin } from '../../services/empleadosService';

interface Props {
  empleadoId: string;
  empleadoNombre: string;
  onClose: () => void;
  onDone: () => void;
}

export function PinDialog({ empleadoId, empleadoNombre, onClose, onDone }: Props) {
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (pin1.length !== 4) { setError('PIN debe ser de 4 dígitos'); return; }
    if (pin1 !== pin2) {
      setError('Los PIN no coinciden. Volvé a empezar.');
      setPin1(''); setPin2(''); setStep(1);
      return;
    }
    setSaving(true); setError(null);
    const { error: err } = await setPin(empleadoId, pin1);
    setSaving(false);
    if (err) { setError(err); return; }
    onDone();
  }

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <h3 style={{ margin: 0, fontSize: 18, marginBottom: 4 }}>Asignar PIN</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
          {empleadoNombre} · {step === 1 ? 'Ingresá un PIN de 4 dígitos' : 'Confirmá el PIN'}
        </p>

        {step === 1 ? (
          <NumericPad
            value={pin1}
            maxLength={4}
            showDots
            onChange={(v) => { setPin1(v); setError(null); }}
            onSubmit={() => setStep(2)}
            ariaLabel="PIN"
          />
        ) : (
          <NumericPad
            value={pin2}
            maxLength={4}
            showDots
            onChange={(v) => { setPin2(v); setError(null); }}
            onSubmit={commit}
            ariaLabel="Confirmar PIN"
            disabled={saving}
          />
        )}

        {error && <div style={errBox}>{error}</div>}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {step === 2 && !saving && (
            <button type="button" onClick={() => { setStep(1); setPin1(''); setPin2(''); setError(null); }} style={btnSecondary}>
              Volver
            </button>
          )}
          <button type="button" onClick={onClose} style={btnSecondary} disabled={saving}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const errBox: React.CSSProperties = { marginTop: 12, padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13 };
