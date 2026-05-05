import { useState, useEffect } from 'react';
import type { Usuario } from '../../types/auth';
import type { Item, ItemGrupo, TaxRate, Estacion } from '../../types/database';
import type { ItemDraft } from '../../services/itemsService';
import { createItem, updateItem } from '../../services/itemsService';
import { listTaxRates } from '../../services/taxRatesService';
import { recalcularAtadosDeItem } from '../../services/preciosService';
import { validarNombre, validarPrecio } from '../../lib/validate';
import { MoneyInput } from '../../components/MoneyInput';
import { EmojiPicker } from '../../components/EmojiPicker';

interface Props {
  user: Usuario;
  grupos: ItemGrupo[];
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}

const ESTACIONES: { value: Estacion | ''; label: string }[] = [
  { value: '',                label: '— heredar del grupo —' },
  { value: 'cocina_caliente', label: 'Cocina caliente' },
  { value: 'cocina_fria',     label: 'Cocina fría' },
  { value: 'barra',           label: 'Barra' },
  { value: 'postres',         label: 'Postres' },
];

export function ItemForm({ user, grupos, item, onClose, onSaved }: Props) {
  const isEdit = item !== null;
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [nombre, setNombre] = useState(item?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(item?.descripcion ?? '');
  const [emoji, setEmoji] = useState<string | null>(item?.emoji ?? null);
  const [codigo, setCodigo] = useState(item?.codigo ?? '');
  const [grupoId, setGrupoId] = useState<number | null>(item?.grupo_id ?? null);
  const [precio, setPrecio] = useState<number>(item?.precio_madre ?? 0);
  const [taxRateId, setTaxRateId] = useState<number | null>(item?.tax_rate_id ?? null);
  const [estacion, setEstacion] = useState<Estacion | ''>((item?.estacion as Estacion) ?? '');
  const [visiblePos, setVisiblePos] = useState(item?.visible_pos ?? true);
  const [visibleQr, setVisibleQr] = useState(item?.visible_qr ?? true);
  const [visibleTienda, setVisibleTienda] = useState(item?.visible_tienda ?? true);
  const [esCombo, setEsCombo] = useState(item?.es_combo ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTaxRates(user.tenant_id).then((res) => setTaxRates(res.data));
  }, [user.tenant_id]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre);
    if (eN) { setError(eN); return; }
    const eP = validarPrecio(precio);
    if (eP) { setError(eP); return; }
    if (!user.tenant_id) {
      setError('Tu usuario no tiene tenant asignado. Contactá soporte.');
      return;
    }
    setSaving(true);
    setError(null);

    const draft: ItemDraft = {
      nombre: nombre.trim(),
      descripcion: descripcion.trim() || null,
      emoji,
      codigo: codigo.trim() || null,
      grupo_id: grupoId,
      precio_madre: precio,
      tax_rate_id: taxRateId,
      estacion: estacion || null,
      visible_pos: visiblePos,
      visible_qr: visibleQr,
      visible_tienda: visibleTienda,
      es_combo: esCombo,
      tenant_id: user.tenant_id,
      local_id: null,
    };

    if (isEdit && item) {
      const precioCambio = item.precio_madre !== precio;
      const { error: err } = await updateItem(item.id, draft);
      if (err) { setError(err); setSaving(false); return; }
      if (precioCambio) {
        await recalcularAtadosDeItem(item.id);
      }
    } else {
      const { error: err } = await createItem(draft);
      if (err) { setError(err); setSaving(false); return; }
    }
    setSaving(false);
    onSaved();
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
          background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 560, width: '100%',
          maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18, marginBottom: 16 }}>{isEdit ? 'Editar item' : 'Nuevo item'}</h3>

        <Field label="Emoji">
          <EmojiPicker value={emoji} onChange={setEmoji} />
        </Field>

        <Field label="Nombre *">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required style={input} autoFocus />
        </Field>

        <Field label="Descripción">
          <textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} style={{ ...input, minHeight: 60 }} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Código interno">
            <input value={codigo} onChange={(e) => setCodigo(e.target.value)} style={input} />
          </Field>
          <Field label="Grupo">
            <select value={grupoId ?? ''} onChange={(e) => setGrupoId(e.target.value ? Number(e.target.value) : null)} style={input}>
              <option value="">— sin grupo —</option>
              {grupos.map((g) => <option key={g.id} value={g.id}>{g.emoji ?? ''} {g.nombre}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Precio madre *">
            <MoneyInput value={precio} onChange={setPrecio} />
          </Field>
          <Field label="Tax rate">
            <select value={taxRateId ?? ''} onChange={(e) => setTaxRateId(e.target.value ? Number(e.target.value) : null)} style={input}>
              <option value="">— heredar del grupo —</option>
              {taxRates.map((t) => <option key={t.id} value={t.id}>{t.nombre} ({t.porcentaje}%)</option>)}
            </select>
          </Field>
        </div>

        <Field label="Estación cocina">
          <select value={estacion} onChange={(e) => setEstacion(e.target.value as Estacion | '')} style={input}>
            {ESTACIONES.map((est) => <option key={est.value} value={est.value}>{est.label}</option>)}
          </select>
        </Field>

        <Field label="Visibilidad">
          <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
            <label><input type="checkbox" checked={visiblePos} onChange={(e) => setVisiblePos(e.target.checked)} /> POS</label>
            <label><input type="checkbox" checked={visibleQr} onChange={(e) => setVisibleQr(e.target.checked)} /> QR</label>
            <label><input type="checkbox" checked={visibleTienda} onChange={(e) => setVisibleTienda(e.target.checked)} /> Tienda</label>
          </div>
        </Field>

        <Field label="">
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={esCombo} onChange={(e) => setEsCombo(e.target.checked)} /> Es combo (la UI de componentes va en sprint siguiente)
          </label>
        </Field>

        {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginTop: 8 }}>{error}</div>}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Guardando…' : isEdit ? 'Guardar' : 'Crear'}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 12, fontSize: 13, color: '#374151' }}>
      {label && <div style={{ marginBottom: 4, fontWeight: 500 }}>{label}</div>}
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit',
};
const btnSecondary: React.CSSProperties = {
  padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14,
};
const btnPrimary: React.CSSProperties = {
  padding: '6px 14px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500,
};
