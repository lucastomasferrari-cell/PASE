interface Props {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function Stepper({ value, onChange, min = 0, max = 999, step = 1 }: Props) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #D1D5DB', borderRadius: 6, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - step))}
        style={btn}
        aria-label="Restar"
      >−</button>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        style={input}
        min={min}
        max={max}
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + step))}
        style={btn}
        aria-label="Sumar"
      >+</button>
    </div>
  );
}

const btn: React.CSSProperties = {
  width: 28, height: 28, border: 'none', background: '#F3F4F6', cursor: 'pointer', fontSize: 16, fontWeight: 600,
};
const input: React.CSSProperties = {
  width: 50, textAlign: 'center', border: 'none', outline: 'none', fontSize: 14, padding: 4,
  fontVariantNumeric: 'tabular-nums',
};
