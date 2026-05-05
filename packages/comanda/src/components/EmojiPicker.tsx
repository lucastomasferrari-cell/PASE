import { useState } from 'react';

const EMOJIS_GASTRO = [
  '🍔', '🌭', '🍕', '🌮', '🌯', '🥙', '🥗', '🍝', '🍜', '🍣',
  '🍤', '🍗', '🥩', '🥪', '🍳', '🥞', '🧇', '🥐', '🥖', '🧀',
  '🍟', '🍿', '🥨', '🍩', '🍪', '🎂', '🧁', '🍰', '🍮', '🍦',
  '☕', '🥤', '🍺', '🍷', '🍹', '🧉',
];

export interface EmojiPickerProps {
  value: string | null;
  onChange: (emoji: string | null) => void;
}

export function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '6px 12px',
          fontSize: 20,
          border: '1px solid #D1D5DB',
          borderRadius: 6,
          background: '#FFFFFF',
          cursor: 'pointer',
          minWidth: 48,
        }}
        aria-label="Elegir emoji"
      >
        {value ?? '😀'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 50,
            marginTop: 4,
            padding: 8,
            border: '1px solid #D1D5DB',
            borderRadius: 8,
            background: '#FFFFFF',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 1fr)',
            gap: 4,
            width: 280,
          }}
        >
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            style={{ padding: 4, fontSize: 14, border: 'none', background: 'transparent', cursor: 'pointer' }}
            title="Sin emoji"
          >
            ✕
          </button>
          {EMOJIS_GASTRO.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { onChange(e); setOpen(false); }}
              style={{
                padding: 4,
                fontSize: 20,
                border: value === e ? '2px solid #2563EB' : '1px solid transparent',
                borderRadius: 4,
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
