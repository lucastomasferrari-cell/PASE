import { useEffect, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { ModifierGroup, Modifier, ModifierTipo } from '../../types/database';
import {
  listModifierGroups, createModifierGroup, updateModifierGroup, softDeleteModifierGroup,
  listModifiers, createModifier, updateModifier, softDeleteModifier,
} from '../../services/modifiersService';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { validarNombre, validarMinMax } from '../../lib/validate';
import { formatARS } from '../../lib/format';

interface Props { user: Usuario }

export function ModificadoresTab({ user }: Props) {
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModifierGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const puedeEditar = tienePermiso(user, 'comanda.modifiers.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await listModifierGroups(user.tenant_id);
    if (err) setError(err);
    setGroups(data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>
          Grupos de modificadores reusables. Cada grupo se asigna a varios items.
        </p>
        {puedeEditar && (
          <button type="button" onClick={() => setEditing('new')} style={btnPrimary}>+ Nuevo grupo</button>
        )}
      </div>

      {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      {loading && <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Cargando…</div>}
      {!loading && groups.length === 0 && (
        <div style={{ padding: 32, border: '1px dashed #D1D5DB', borderRadius: 8, textAlign: 'center', color: '#6B7280' }}>
          No hay grupos de modificadores. Tocá "+ Nuevo grupo" para crear el primero.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
        {groups.map((g) => (
          <ModifierGroupCard
            key={g.id}
            group={g}
            puedeEditar={puedeEditar}
            tenantId={user.tenant_id}
            onEdit={() => setEditing(g)}
            onDelete={() => setConfirmDelete(g)}
          />
        ))}
      </div>

      {editing && (
        <GroupForm
          user={user}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Eliminar grupo de modificadores"
        destructive
        message={confirmDelete ? <>¿Borrar <strong>{confirmDelete.nombre}</strong>? Las asignaciones a items se mantienen pero el grupo desaparece de los desplegables.</> : ''}
        confirmLabel="Eliminar"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          const { error: err } = await softDeleteModifierGroup(confirmDelete.id);
          if (err) setError(err);
          setConfirmDelete(null);
          reload();
        }}
      />
    </div>
  );
}

interface CardProps {
  group: ModifierGroup;
  puedeEditar: boolean;
  tenantId: string | null;
  onEdit: () => void;
  onDelete: () => void;
}

function ModifierGroupCard({ group, puedeEditar, tenantId, onEdit, onDelete }: CardProps) {
  const [opciones, setOpciones] = useState<Modifier[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoPrecio, setNuevoPrecio] = useState(0);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listModifiers(group.id);
    setOpciones(data);
    setLoading(false);
  }, [group.id]);

  useEffect(() => { reload(); }, [reload]);

  async function addOpcion() {
    const eN = validarNombre(nuevoNombre); if (eN) { alert(eN); return; }
    if (!tenantId) return;
    const { error: err } = await createModifier({
      modifier_group_id: group.id, tenant_id: tenantId,
      nombre: nuevoNombre.trim(), precio_extra: nuevoPrecio,
      orden: opciones.length, activo: true,
    });
    if (err) { alert(err); return; }
    setNuevoNombre(''); setNuevoPrecio(0); setShowAdd(false);
    reload();
  }

  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 12, background: '#FFFFFF' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <strong>{group.nombre}</strong>
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            <Badge variant="violet">{tipoLabel(group.tipo)}</Badge>
            {group.requerido && <Badge variant="amber">Requerido</Badge>}
            <Badge variant="gray">
              min {group.min_seleccion} / max {group.max_seleccion ?? '∞'}
            </Badge>
          </div>
        </div>
        {puedeEditar && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" onClick={onEdit} style={btnSm}>Editar</button>
            <button type="button" onClick={onDelete} style={{ ...btnSm, color: '#DC2626' }}>×</button>
          </div>
        )}
      </div>

      {group.descripcion && <div style={{ marginTop: 8, fontSize: 13, color: '#6B7280' }}>{group.descripcion}</div>}

      <div style={{ marginTop: 12, borderTop: '1px solid #F3F4F6', paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 6 }}>Opciones</div>
        {loading && <div style={{ fontSize: 12, color: '#9CA3AF' }}>…</div>}
        {!loading && opciones.length === 0 && <div style={{ fontSize: 12, color: '#9CA3AF' }}>Sin opciones</div>}
        {opciones.map((op) => (
          <div key={op.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
            <span>{op.nombre}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {Number(op.precio_extra) > 0 && <span style={{ fontSize: 11, color: '#059669' }}>+{formatARS(op.precio_extra)}</span>}
              {puedeEditar && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Borrar opción "${op.nombre}"?`)) return;
                    await softDeleteModifier(op.id);
                    reload();
                  }}
                  style={{ ...btnSm, padding: '2px 8px', fontSize: 11 }}
                >×</button>
              )}
              {puedeEditar && (
                <ToggleActivo
                  initial={op.activo}
                  onChange={async (v) => { await updateModifier(op.id, { activo: v }); reload(); }}
                />
              )}
            </div>
          </div>
        ))}

        {puedeEditar && !showAdd && (
          <button type="button" onClick={() => setShowAdd(true)} style={{ ...btnSm, marginTop: 8, fontSize: 12 }}>+ Agregar opción</button>
        )}
        {puedeEditar && showAdd && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <input
              value={nuevoNombre}
              onChange={(e) => setNuevoNombre(e.target.value)}
              placeholder="Nombre"
              autoFocus
              style={{ flex: 2, padding: '4px 8px', fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 4 }}
            />
            <div style={{ flex: 1 }}>
              <MoneyInput value={nuevoPrecio} onChange={setNuevoPrecio} placeholder="$0,00" style={{ fontSize: 12, padding: '4px 6px' }} />
            </div>
            <button type="button" onClick={addOpcion} style={{ ...btnSm, fontSize: 12 }}>OK</button>
            <button type="button" onClick={() => { setShowAdd(false); setNuevoNombre(''); setNuevoPrecio(0); }} style={{ ...btnSm, fontSize: 12 }}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleActivo({ initial, onChange }: { initial: boolean; onChange: (v: boolean) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      type="checkbox"
      checked={v}
      onChange={(e) => { setV(e.target.checked); onChange(e.target.checked); }}
      title="Activo"
      style={{ cursor: 'pointer' }}
    />
  );
}

function tipoLabel(t: ModifierTipo): string {
  switch (t) {
    case 'opcion': return 'Opción única';
    case 'extra': return 'Extra (múltiple)';
    case 'aclaracion': return 'Aclaración';
    case 'sin_con': return 'Sin / Con';
  }
}

function GroupForm({ user, group, onClose, onSaved }: { user: Usuario; group: ModifierGroup | null; onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState(group?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(group?.descripcion ?? '');
  const [tipo, setTipo] = useState<ModifierTipo>(group?.tipo ?? 'opcion');
  const [requerido, setRequerido] = useState(group?.requerido ?? false);
  const [minSel, setMinSel] = useState(group?.min_seleccion ?? 0);
  const [maxSel, setMaxSel] = useState<number | null>(group?.max_seleccion ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre); if (eN) { setError(eN); return; }
    const eM = validarMinMax(minSel, maxSel); if (eM) { setError(eM); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    setSaving(true);
    const draft = {
      nombre: nombre.trim(), descripcion: descripcion.trim() || null,
      tipo, requerido, min_seleccion: minSel, max_seleccion: maxSel,
      tenant_id: user.tenant_id, local_id: null,
    };
    const { error: err } = group ? await updateModifierGroup(group.id, draft) : await createModifierGroup(draft);
    setSaving(false);
    if (err) { setError(err); return; }
    onSaved();
  }

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modal}>
        <h3 style={{ margin: 0, fontSize: 18, marginBottom: 16 }}>{group ? 'Editar grupo' : 'Nuevo grupo de modificadores'}</h3>

        <Field label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} required style={input} autoFocus /></Field>
        <Field label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>

        <Field label="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as ModifierTipo)} style={input}>
            <option value="opcion">Opción única (cocción)</option>
            <option value="extra">Extra múltiple (guarniciones)</option>
            <option value="aclaracion">Aclaración (texto libre)</option>
            <option value="sin_con">Sin / Con (ingredientes)</option>
          </select>
        </Field>

        <Field label="">
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={requerido} onChange={(e) => setRequerido(e.target.checked)} /> Requerido
          </label>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Mín selección"><input type="number" min={0} value={minSel} onChange={(e) => setMinSel(Number(e.target.value))} style={input} /></Field>
          <Field label="Máx selección (vacío = sin límite)">
            <input type="number" min={0} value={maxSel ?? ''} onChange={(e) => setMaxSel(e.target.value ? Number(e.target.value) : null)} style={input} />
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

const btnSm: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer', fontSize: 12 };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const input: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginTop: 8 };
