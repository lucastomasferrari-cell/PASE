import { useEffect } from 'react';

interface Props {
  value: string;
  maxLength?: number;
  onChange: (v: string) => void;
  onSubmit?: () => void;          // se dispara cuando llega a maxLength
  showDots?: boolean;             // muestra dots para PIN; si false muestra el number
  ariaLabel?: string;
  disabled?: boolean;
}

// Pad numérico reusable — PIN (4 dígitos), montos en arqueo, etc.
export function NumericPad({
  value, maxLength = 4, onChange, onSubmit, showDots = false, ariaLabel = 'Pad numérico', disabled,
}: Props) {

  // Soporte de teclado
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key >= '0' && e.key <= '9') {
        if (value.length < maxLength) onChange(value + e.key);
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        onChange(value.slice(0, -1));
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (onSubmit) onSubmit();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [value, maxLength, onChange, onSubmit, disabled]);

  function press(d: string) {
    if (disabled) return;
    if (value.length < maxLength) {
      const next = value + d;
      onChange(next);
      if (next.length === maxLength && onSubmit) {
        // Pequeño delay para que el último dot se vea antes de enviar
        setTimeout(() => onSubmit(), 80);
      }
    }
  }

  function back() {
    if (disabled) return;
    onChange(value.slice(0, -1));
  }

  function clear() {
    if (disabled) return;
    onChange('');
  }

  return (
    <div role="group" aria-label={ariaLabel} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div aria-live="polite" style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        {showDots ? (
          Array.from({ length: maxLength }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 16, height: 16, borderRadius: '50%',
                background: i < value.length ? '#111827' : 'transparent',
                border: '2px solid #6B7280',
              }}
            />
          ))
        ) : (
          <div style={{
            fontSize: 32, fontWeight: 600, fontFamily: 'system-ui',
            minWidth: 120, textAlign: 'center', letterSpacing: 4,
          }}>
            {value || '—'}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, width: 240 }}>
        {['1','2','3','4','5','6','7','8','9'].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={disabled} style={btnDigit}>
            {d}
          </button>
        ))}
        <button type="button" onClick={clear} disabled={disabled} style={{ ...btnDigit, background: '#F3F4F6', fontSize: 14 }}>
          Borrar
        </button>
        <button type="button" onClick={() => press('0')} disabled={disabled} style={btnDigit}>
          0
        </button>
        <button type="button" onClick={back} disabled={disabled} style={{ ...btnDigit, background: '#F3F4F6', fontSize: 14 }}>
          ←
        </button>
      </div>
    </div>
  );
}

const btnDigit: React.CSSProperties = {
  height: 64,
  fontSize: 22,
  fontWeight: 500,
  border: '1px solid #D1D5DB',
  borderRadius: 8,
  background: '#FFFFFF',
  cursor: 'pointer',
  fontFamily: 'system-ui',
};
