import { useEffect, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { Canal, ModoPos } from '../../types/database';
import { listCanales, createCanal, updateCanal, toggleCanalActivo } from '../../services/canalesService';
import type { CanalDraft } from '../../services/canalesService';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { EmojiPicker } from '../../components/EmojiPicker';
import { validarNombre, validarSlug, validarPorcentaje } from '../../lib/validate';

interface Props { user: Usuario }

export function CanalesTab({ user }: Props) {
  const [canales, setCanales] = useState<Canal[]>([]);
  const [editing, setEditing] = useState<Canal | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.canales.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await listCanales(user.tenant_id);
    if (err) setError(err);
    setCanales(data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        {puedeEditar && (
          <button type="button" onClick={() => setEditing('new')} style={btnPrimary}>+ Nuevo canal</button>
        )}
      </div>

      {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead style={{ background: '#F9FAFB' }}>
            <tr>
              <th style={th}>Canal</th>
              <th style={th}>Modo POS</th>
              <th style={th}>Atadura</th>
              <th style={{ ...th, textAlign: 'right' }}>Ajuste %</th>
              <th style={{ ...th, textAlign: 'right' }}>Comisión %</th>
              <th style={{ ...th, textAlign: 'right' }}>Redondeo</th>
              <th style={th}>Activo</th>
              <th style={th}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Cargando…</td></tr>}
            {!loading && canales.length === 0 && <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Sin canales.</td></tr>}
            {canales.map((c) => (
              <tr key={c.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                <td style={td}>
                  <span style={{ marginRight: 6, fontSize: 18 }}>{c.emoji ?? '🛍️'}</span>
                  <strong>{c.nombre}</strong>
                  <div style={{ fontSize: 11, color: '#9CA3AF' }}>{c.slug}{c.grupo ? ` · ${c.grupo}` : ''}</div>
                </td>
                <td style={td}><Badge variant="blue">{c.modo_pos}</Badge></td>
                <td style={td}>
                  {c.atado_madre ? <Badge variant="violet">🔗 Atado al madre</Badge> : <Badge variant="gray">✏️ Independiente</Badge>}
                </td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(c.ajuste_madre_pct).toFixed(2)}%</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(c.comision_externa_pct).toFixed(2)}%</td>
                <td style={{ ...td, textAlign: 'right' }}>{c.redondeo_a === 1 ? 'al peso' : `a $${c.redondeo_a}`}</td>
                <td style={td}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={c.activo}
                      disabled={!puedeEditar}
                      onChange={async (e) => {
                        const { error: err } = await toggleCanalActivo(c.id, e.target.checked);
                        if (err) setError(err);
                        reload();
                      }}
                    />
                    {c.activo ? 'Sí' : 'No'}
                  </label>
                </td>
                <td style={td}>
                  {puedeEditar && <button type="button" onClick={() => setEditing(c)} style={btnSm}>Editar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <CanalForm
          user={user}
          canal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function CanalForm({ user, canal, onClose, onSaved }: { user: Usuario; canal: Canal | null; onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState(canal?.nombre ?? '');
  const [slug, setSlug] = useState(canal?.slug ?? '');
  const [emoji, setEmoji] = useState<string | null>(canal?.emoji ?? null);
  const [color, setColor] = useState(canal?.color ?? '#9CA3AF');
  const [modoPos, setModoPos] = useState<ModoPos>(canal?.modo_pos ?? 'salon');
  const [atadoMadre, setAtadoMadre] = useState(canal?.atado_madre ?? true);
  const [ajustePct, setAjustePct] = useState<number>(canal?.ajuste_madre_pct ?? 0);
  const [comisionPct, setComisionPct] = useState<number>(canal?.comision_externa_pct ?? 0);
  const [redondeoA, setRedondeoA] = useState<number>(canal?.redondeo_a ?? 1);
  const [activo, setActivo] = useState(canal?.activo ?? true);
  const [grupo, setGrupo] = useState(canal?.grupo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre); if (eN) { setError(eN); return; }
    const eS = validarSlug(slug); if (eS) { setError(eS); return; }
    const eA = validarPorcentaje(ajustePct); if (eA) { setError(eA); return; }
    const eC = validarPorcentaje(comisionPct); if (eC) { setError(eC); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }

    setSaving(true);
    const draft: CanalDraft = {
      nombre: nombre.trim(), slug: slug.trim(), emoji, color,
      modo_pos: modoPos, atado_madre: atadoMadre,
      ajuste_madre_pct: ajustePct, comision_externa_pct: comisionPct,
      redondeo_a: redondeoA, activo, grupo: grupo.trim() || null,
      tenant_id: user.tenant_id, local_id: null,
    };
    const { error: err } = canal ? await updateCanal(canal.id, draft) : await createCanal(draft);
    setSaving(false);
    if (err) { setError(err); return; }
    onSaved();
  }

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modalBody}>
        <h3 style={{ margin: 0, marginBottom: 16, fontSize: 18 }}>{canal ? 'Editar canal' : 'Nuevo canal'}</h3>

        <Field label="Emoji"><EmojiPicker value={emoji} onChange={setEmoji} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} required style={input} autoFocus /></Field>
          <Field label="Color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ ...input, padding: 2, height: 38 }} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Slug *"><input value={slug} onChange={(e) => setSlug(e.target.value)} required placeholder="rappi" style={input} /></Field>
          <Field label="Modo POS *">
            <select value={modoPos} onChange={(e) => setModoPos(e.target.value as ModoPos)} style={input}>
              <option value="salon">Salón</option>
              <option value="mostrador">Mostrador</option>
              <option value="pedidos">Pedidos</option>
            </select>
          </Field>
        </div>

        <Field label="">
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={atadoMadre} onChange={(e) => setAtadoMadre(e.target.checked)} />
            {' '}🔗 Atado al precio madre (recálculo automático)
          </label>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Ajuste %"><input type="number" step="0.01" value={ajustePct} onChange={(e) => setAjustePct(Number(e.target.value))} style={input} /></Field>
          <Field label="Comisión %"><input type="number" step="0.01" value={comisionPct} onChange={(e) => setComisionPct(Number(e.target.value))} style={input} /></Field>
          <Field label="Redondeo a">
            <select value={redondeoA} onChange={(e) => setRedondeoA(Number(e.target.value))} style={input}>
              <option value={1}>Al peso</option>
              <option value={10}>Decena</option>
              <option value={100}>Centena</option>
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Grupo (opcional)">
            <input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder="presencial / third-party / online-propio" style={input} />
          </Field>
          <Field label="">
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} /> Activo
            </label>
          </Field>
        </div>

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
      {label && <div style={{ marginBottom: 4, fontWeight: 500, color: '#374151' }}>{label}</div>}
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
const modalBody: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 560, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginTop: 8 };
