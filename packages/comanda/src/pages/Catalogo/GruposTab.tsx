import { useEffect, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { ItemGrupo, TaxRate, Estacion } from '../../types/database';
import { listGrupos, createGrupo, updateGrupo, softDeleteGrupo, countItemsPorGrupo } from '../../services/gruposService';
import { listTaxRates } from '../../services/taxRatesService';
import { tienePermiso } from '../../lib/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmojiPicker } from '../../components/EmojiPicker';
import { validarNombre } from '../../lib/validate';

interface Props {
  user: Usuario;
}

export function GruposTab({ user }: Props) {
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [editing, setEditing] = useState<ItemGrupo | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemGrupo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const puedeEditar = tienePermiso(user, 'comanda.catalogo.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const [gr, tr, ct] = await Promise.all([
      listGrupos(user.tenant_id),
      listTaxRates(user.tenant_id),
      countItemsPorGrupo(user.tenant_id),
    ]);
    setGrupos(gr.data);
    setTaxRates(tr.data);
    setCounts(ct);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        {puedeEditar && (
          <button type="button" onClick={() => setEditing('new')} style={btnPrimary}>+ Nuevo grupo</button>
        )}
      </div>

      {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead style={{ background: '#F9FAFB' }}>
            <tr>
              <th style={th}>Grupo</th>
              <th style={th}>Color</th>
              <th style={th}>Tax</th>
              <th style={th}>Estación default</th>
              <th style={th}>Items</th>
              <th style={th}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Cargando…</td></tr>}
            {!loading && grupos.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Sin grupos.</td></tr>}
            {grupos.map((g) => (
              <tr key={g.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                <td style={td}><span style={{ marginRight: 6, fontSize: 18 }}>{g.emoji ?? '🗂️'}</span>{g.nombre}</td>
                <td style={td}>
                  {g.color ? <span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: g.color, border: '1px solid #D1D5DB' }} /> : <span style={{ color: '#9CA3AF' }}>—</span>}
                </td>
                <td style={td}>{taxRates.find((t) => t.id === g.tax_rate_id)?.nombre ?? <span style={{ color: '#9CA3AF' }}>—</span>}</td>
                <td style={td}>{g.estacion_default ?? <span style={{ color: '#9CA3AF' }}>—</span>}</td>
                <td style={td}>{counts[g.id] ?? 0}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {puedeEditar && <button type="button" onClick={() => setEditing(g)} style={btnSm}>Editar</button>}
                    {puedeEditar && <button type="button" onClick={() => setConfirmDelete(g)} style={{ ...btnSm, color: '#DC2626' }}>Eliminar</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <GrupoFormDialog
          user={user}
          taxRates={taxRates}
          grupo={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Eliminar grupo"
        destructive
        description={confirmDelete ? <>¿Borrar grupo <strong>{confirmDelete.nombre}</strong>?</> : ''}
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!confirmDelete) return;
          const { error: err } = await softDeleteGrupo(confirmDelete.id);
          if (err) setError(err);
          setConfirmDelete(null);
          reload();
        }}
      />
    </div>
  );
}

interface GrupoFormProps {
  user: Usuario;
  taxRates: TaxRate[];
  grupo: ItemGrupo | null;
  onClose: () => void;
  onSaved: () => void;
}

function GrupoFormDialog({ user, taxRates, grupo, onClose, onSaved }: GrupoFormProps) {
  const [nombre, setNombre] = useState(grupo?.nombre ?? '');
  const [emoji, setEmoji] = useState<string | null>(grupo?.emoji ?? null);
  const [color, setColor] = useState(grupo?.color ?? '#9CA3AF');
  const [orden, setOrden] = useState(grupo?.orden ?? 0);
  const [taxRateId, setTaxRateId] = useState<number | null>(grupo?.tax_rate_id ?? null);
  const [estacion, setEstacion] = useState<Estacion | ''>((grupo?.estacion_default as Estacion) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre);
    if (eN) { setError(eN); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    setSaving(true);
    const draft = { nombre: nombre.trim(), emoji, color, orden, tax_rate_id: taxRateId, estacion_default: estacion || null, tenant_id: user.tenant_id, local_id: null };
    const { error: err } = grupo ? await updateGrupo(grupo.id, draft) : await createGrupo(draft);
    setSaving(false);
    if (err) { setError(err); return; }
    onSaved();
  }

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modalBody}>
        <h3 style={{ margin: 0, marginBottom: 16, fontSize: 18 }}>{grupo ? 'Editar grupo' : 'Nuevo grupo'}</h3>

        <Field label="Emoji"><EmojiPicker value={emoji} onChange={setEmoji} /></Field>
        <Field label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} required style={input} autoFocus /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ ...input, padding: 2, height: 38 }} /></Field>
          <Field label="Orden"><input type="number" value={orden} onChange={(e) => setOrden(Number(e.target.value))} style={input} /></Field>
        </div>
        <Field label="Tax rate default">
          <select value={taxRateId ?? ''} onChange={(e) => setTaxRateId(e.target.value ? Number(e.target.value) : null)} style={input}>
            <option value="">— sin default —</option>
            {taxRates.map((t) => <option key={t.id} value={t.id}>{t.nombre} ({t.porcentaje}%)</option>)}
          </select>
        </Field>
        <Field label="Estación cocina default">
          <select value={estacion} onChange={(e) => setEstacion(e.target.value as Estacion | '')} style={input}>
            <option value="">— sin default —</option>
            <option value="cocina_caliente">Cocina caliente</option>
            <option value="cocina_fria">Cocina fría</option>
            <option value="barra">Barra</option>
            <option value="postres">Postres</option>
          </select>
        </Field>

        {error && <div style={errBox}>{error}</div>}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Guardando…' : 'Guardar'}</button>
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

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' };
const btnSm: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer', fontSize: 12 };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const input: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modalBody: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginTop: 8 };
