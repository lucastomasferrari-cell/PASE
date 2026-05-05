import { useEffect, useState } from 'react';

export interface SearchInputProps {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
  debounceMs?: number;
  style?: React.CSSProperties;
}

export function SearchInput({ value, onChange, placeholder = 'Buscar…', debounceMs = 200, style }: SearchInputProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (local !== value) onChange(local);
    }, debounceMs);
    return () => clearTimeout(t);
  }, [local, value, debounceMs, onChange]);

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '6px 28px 6px 10px',
          border: '1px solid #D1D5DB',
          borderRadius: 6,
          fontSize: 14,
          width: '100%',
          ...style,
        }}
      />
      {local && (
        <button
          type="button"
          onClick={() => { setLocal(''); onChange(''); }}
          aria-label="Limpiar"
          style={{
            position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: '#6B7280',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
