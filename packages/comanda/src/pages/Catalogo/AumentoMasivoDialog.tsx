import { useState } from 'react';
import type { Usuario } from '../../types/auth';
import type { ItemGrupo } from '../../types/database';
import { aumentoMasivo } from '../../services/preciosService';
import { translateError } from '../../lib/errors';
import { validarPorcentaje } from '../../lib/validate';

interface Props {
  user: Usuario;
  grupos: ItemGrupo[];
  totalItems: number;
  onClose: () => void;
  onDone: (result: { itemsAfectados: number; preciosRecalculados: number }) => void;
}

export function AumentoMasivoDialog({ user, grupos, totalItems, onClose, onDone }: Props) {
  const [grupoId, setGrupoId] = useState<number | null>(null);
  const [porcentaje, setPorcentaje] = useState<number>(10);
  const [redondeoA, setRedondeoA] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const itemsPreview = grupoId === null ? totalItems : null; // si es por grupo no preconozco el count

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eP = validarPorcentaje(porcentaje);
    if (eP) { setError(eP); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    setSaving(true); setError(null);
    const { data, error: err } = await aumentoMasivo({
      tenantId: user.tenant_id,
      localId: null,
      grupoId,
      porcentaje,
      redondeoA,
    });
    setSaving(false);
    if (err || !data) { setError(translateError({ message: err ?? 'Error' })); return; }
    onDone(data);
  }

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modal}>
        <h3 style={{ margin: 0, marginBottom: 4, fontSize: 18 }}>Aumento masivo de precios</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
          Sube el precio madre y recalcula los precios de los canales atados.
          La edición manual queda pisada.
        </p>

        <Field label="Grupo a afectar">
          <select value={grupoId ?? ''} onChange={(e) => setGrupoId(e.target.value ? Number(e.target.value) : null)} style={input}>
            <option value="">Todos los grupos</option>
            {grupos.map((g) => <option key={g.id} value={g.id}>{g.emoji ?? ''} {g.nombre}</option>)}
          </select>
        </Field>

        <Field label="Porcentaje (positivo o negativo)">
          <input type="number" step="0.01" value={porcentaje} onChange={(e) => setPorcentaje(Number(e.target.value))} style={input} required autoFocus />
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>Ej: 15 = +15%, -5 = -5%</div>
        </Field>

        <Field label="Redondear a">
          <select value={redondeoA} onChange={(e) => setRedondeoA(Number(e.target.value))} style={input}>
            <option value={1}>Al peso</option>
            <option value={10}>Decena</option>
            <option value={100}>Centena</option>
          </select>
        </Field>

        {itemsPreview !== null && (
          <div style={{ padding: 10, background: '#F3F4F6', borderRadius: 6, fontSize: 13 }}>
            Aproximadamente <strong>{itemsPreview}</strong> items afectados.
          </div>
        )}

        {error && <div style={errBox}>{error}</div>}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Aplicando…' : 'Aplicar'}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
      <div style={{ marginBottom: 4, fontWeight: 500, color: '#374151' }}>{label}</div>
      {children}
    </label>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 460, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const input: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginTop: 8 };
