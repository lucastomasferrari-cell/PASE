import { useEffect, useMemo, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { Canal, ItemGrupo, ItemPrecioCanal, Item } from '../../types/database';
import { listItems } from '../../services/itemsService';
import { listGrupos } from '../../services/gruposService';
import { listCanales } from '../../services/canalesService';
import { listPreciosPorTenant, setPrecioCelda } from '../../services/preciosService';
import { tienePermiso } from '../../lib/auth';
import { formatARS, parseARS, relativoCorto } from '../../lib/format';
import { SearchInput } from '../../components/SearchInput';
import { AumentoMasivoDialog } from './AumentoMasivoDialog';

interface Props { user: Usuario }

export function ListaPreciosTab({ user }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [precios, setPrecios] = useState<ItemPrecioCanal[]>([]);
  const [search, setSearch] = useState('');
  const [grupoFilter, setGrupoFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAumento, setShowAumento] = useState(false);
  const [lastChange, setLastChange] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.precios.editar');
  const puedeAumento = tienePermiso(user, 'comanda.precios.aumento_masivo');

  const reload = useCallback(async () => {
    setLoading(true);
    const [itRes, grRes, caRes, prRes] = await Promise.all([
      listItems({ tenantId: user.tenant_id }),
      listGrupos(user.tenant_id),
      listCanales(user.tenant_id, true),
      listPreciosPorTenant(user.tenant_id),
    ]);
    if (itRes.error) setError(itRes.error);
    setItems(itRes.data);
    setGrupos(grRes.data);
    setCanales(caRes.data);
    setPrecios(prRes.data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  const itemsFiltrados = useMemo(() => {
    return items.filter((i) => {
      if (grupoFilter !== null && i.grupo_id !== grupoFilter) return false;
      if (search.trim() && !i.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [items, search, grupoFilter]);

  // Map (item_id, canal_id) → ipc
  const precioMap = useMemo(() => {
    const m = new Map<string, ItemPrecioCanal>();
    for (const p of precios) m.set(`${p.item_id}-${p.canal_id}`, p);
    return m;
  }, [precios]);

  // Calcula precio efectivo: si hay ipc usa ese, si no calcula desde madre + canal.atado_madre
  function precioEfectivo(item: Item, canal: Canal): { valor: number; manual: boolean; existe: boolean } {
    const ipc = precioMap.get(`${item.id}-${canal.id}`);
    if (ipc) return { valor: Number(ipc.precio), manual: ipc.edicion_manual, existe: true };
    // Calcular implícito desde madre
    const ajustado = Number(item.precio_madre) * (1 + Number(canal.ajuste_madre_pct) / 100);
    const redondeado = Math.round(ajustado / canal.redondeo_a) * canal.redondeo_a;
    return { valor: redondeado, manual: false, existe: false };
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar item…" />
        </div>
        <select
          value={grupoFilter ?? ''}
          onChange={(e) => setGrupoFilter(e.target.value ? Number(e.target.value) : null)}
          style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14 }}
        >
          <option value="">Todos los grupos</option>
          {grupos.map((g) => <option key={g.id} value={g.id}>{g.emoji ?? ''} {g.nombre}</option>)}
        </select>
        <div style={{ flex: 1, fontSize: 12, color: '#6B7280', textAlign: 'right' }}>
          {itemsFiltrados.length} items
          {lastChange && <> · última modificación {relativoCorto(lastChange)}</>}
        </div>
        {puedeAumento && (
          <button type="button" onClick={() => setShowAumento(true)} style={btnPrimary}>📈 Aumento masivo</button>
        )}
      </div>

      {error && <div style={{ padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'auto', maxHeight: '70vh' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: '#F9FAFB', position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              <th style={{ ...thSticky, left: 0, zIndex: 2, minWidth: 180 }}>Item</th>
              <th style={{ ...th, background: '#FEF2F2', borderLeft: '2px solid #FCA5A5', minWidth: 120 }}>
                🔗 Madre
              </th>
              {canales.map((c) => (
                <th key={c.id} style={{ ...th, minWidth: 110 }}>
                  <div>{c.emoji ?? ''} {c.nombre}</div>
                  <div style={{ fontSize: 10, color: '#6B7280', fontWeight: 400 }}>
                    {c.atado_madre ? `🔗 ${c.ajuste_madre_pct >= 0 ? '+' : ''}${Number(c.ajuste_madre_pct)}%` : '✏️ Indep'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={2 + canales.length} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Cargando…</td></tr>}
            {!loading && itemsFiltrados.length === 0 && (
              <tr><td colSpan={2 + canales.length} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Sin items.</td></tr>
            )}
            {itemsFiltrados.map((it) => (
              <tr key={it.id} style={{ borderTop: '1px solid #F3F4F6' }}>
                <td style={{ ...tdSticky, left: 0, background: '#FFFFFF', zIndex: 1 }}>
                  <span style={{ marginRight: 4 }}>{it.emoji ?? '📦'}</span>
                  {it.nombre}
                </td>
                <td style={{ ...tdNum, background: '#FEF2F2', borderLeft: '2px solid #FCA5A5', fontWeight: 600 }}>
                  {formatARS(it.precio_madre)}
                </td>
                {canales.map((c) => {
                  const ef = precioEfectivo(it, c);
                  return (
                    <PrecioCell
                      key={c.id}
                      item={it}
                      canal={c}
                      precio={ef.valor}
                      manual={ef.manual}
                      editable={puedeEditar}
                      onSaved={() => { setLastChange(new Date().toISOString()); reload(); }}
                      tenantId={user.tenant_id}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#6B7280' }}>
        🔗 atado al madre · ✏️ editado a mano (sigue atado, próximo aumento masivo lo pisa)
      </div>

      {showAumento && (
        <AumentoMasivoDialog
          user={user}
          grupos={grupos}
          totalItems={items.length}
          onClose={() => setShowAumento(false)}
          onDone={(r) => {
            setShowAumento(false);
            setLastChange(new Date().toISOString());
            reload();
            setError(null);
            alert(`Aumento aplicado: ${r.itemsAfectados} items, ${r.preciosRecalculados} precios recalculados.`);
          }}
        />
      )}
    </div>
  );
}

interface CellProps {
  item: Item;
  canal: Canal;
  precio: number;
  manual: boolean;
  editable: boolean;
  tenantId: string | null;
  onSaved: () => void;
}

function PrecioCell({ item, canal, precio, manual, editable, tenantId, onSaved }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatARS(precio));
  const [saving, setSaving] = useState(false);

  async function commit() {
    const n = parseARS(text);
    if (Number.isNaN(n) || n < 0) { setText(formatARS(precio)); setEditing(false); return; }
    if (!tenantId) { setEditing(false); return; }
    setSaving(true);
    const { error: err } = await setPrecioCelda(item.id, canal.id, n, tenantId, item.local_id);
    setSaving(false);
    setEditing(false);
    if (err) { alert(err); return; }
    onSaved();
  }

  const isEdited = manual;
  const bg = isEdited ? '#D1FAE5' : '#F9FAFB';
  const border = isEdited ? '1px solid #6EE7B7' : '1px solid transparent';
  const indicador = isEdited ? '✏️ manual' : '🔗 atado';

  if (editing) {
    return (
      <td style={{ ...tdNum, background: '#FFFBEB' }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setText(formatARS(precio)); setEditing(false); } }}
          style={{ width: '100%', padding: 4, border: '1px solid #FCD34D', borderRadius: 4, fontSize: 13, textAlign: 'right' }}
        />
      </td>
    );
  }

  return (
    <td
      style={{ ...tdNum, background: bg, border, cursor: editable ? 'pointer' : 'default', position: 'relative' }}
      onClick={() => editable && setEditing(true)}
      title={`${formatARS(precio)} · ${indicador}`}
    >
      {saving ? '…' : formatARS(precio)}
      <div style={{ fontSize: 9, color: isEdited ? '#065F46' : '#6B7280' }}>{indicador}</div>
    </td>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#374151', fontSize: 12, background: '#F9FAFB' };
const thSticky: React.CSSProperties = { ...th, position: 'sticky' };
const tdNum: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 };
const tdSticky: React.CSSProperties = { padding: '6px 10px', position: 'sticky', fontSize: 13 };
const btnPrimary: React.CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
