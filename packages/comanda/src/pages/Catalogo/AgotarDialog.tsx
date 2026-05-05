import { useState } from 'react';
import type { Item } from '../../types/database';
import { marcarAgotado } from '../../services/itemsService';
import { translateError } from '../../lib/errors';

interface Props {
  item: Item;
  onClose: () => void;
  onDone: () => void;
}

export function AgotarDialog({ item, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [hasta, setHasta] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) { setError('El motivo es requerido'); return; }
    setSaving(true); setError(null);
    const hastaIso = hasta ? new Date(hasta).toISOString() : null;
    const { error: err } = await marcarAgotado(item.id, motivo.trim(), hastaIso);
    setSaving(false);
    if (err) { setError(translateError({ message: err })); return; }
    onDone();
  }

  return (
    <div
      role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: '#FFFFFF', borderRadius: 8, padding: 20, maxWidth: 420, width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>Marcar como agotado</h3>
        <div style={{ marginTop: 4, fontSize: 13, color: '#6B7280' }}>{item.emoji ?? '📦'} {item.nombre}</div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500 }}>Motivo *</label>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
            autoFocus
            placeholder="Sin stock, problema en cocina…"
            style={{ marginTop: 4, padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500 }}>Reactivar automáticamente (opcional)</label>
          <input
            type="datetime-local"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            style={{ marginTop: 4, padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%' }}
          />
        </div>

        {error && <div style={{ marginTop: 12, padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13 }}>{error}</div>}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
          <button type="submit" disabled={saving} style={{ padding: '6px 14px', border: 'none', borderRadius: 6, background: '#D97706', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>
            {saving ? 'Marcando…' : 'Marcar agotado'}
          </button>
        </div>
      </form>
    </div>
  );
}
