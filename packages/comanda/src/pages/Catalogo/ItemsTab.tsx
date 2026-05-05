import { useEffect, useState, useCallback } from 'react';
import type { Usuario } from '../../types/auth';
import type { ItemConGrupo } from '../../services/itemsService';
import { listItems, softDeleteItem } from '../../services/itemsService';
import { listGrupos } from '../../services/gruposService';
import type { ItemGrupo, ItemEstado } from '../../types/database';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { SearchInput } from '../../components/SearchInput';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatARS } from '../../lib/format';
import { ItemForm } from './ItemForm';
import { AgotarDialog } from './AgotarDialog';

interface Props {
  user: Usuario;
}

type EstadoFilter = ItemEstado | 'todos';

export function ItemsTab({ user }: Props) {
  const [items, setItems] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [search, setSearch] = useState('');
  const [grupoId, setGrupoId] = useState<number | null>(null);
  const [estado, setEstado] = useState<EstadoFilter>('todos');
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState<ItemConGrupo | 'new' | null>(null);
  const [agotarItem, setAgotarItem] = useState<ItemConGrupo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemConGrupo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.catalogo.editar');
  const puedeEliminar = tienePermiso(user, 'comanda.catalogo.eliminar');

  const reload = useCallback(async () => {
    setLoading(true);
    const [itemsRes, gruposRes] = await Promise.all([
      listItems({ search, grupoId, estado, tenantId: user.tenant_id }),
      listGrupos(user.tenant_id),
    ]);
    if (itemsRes.error) setError(itemsRes.error);
    setItems(itemsRes.data);
    setGrupos(gruposRes.data);
    setLoading(false);
  }, [search, grupoId, estado, user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  function badgeEstado(e: ItemEstado) {
    if (e === 'disponible') return <Badge variant="green">Disponible</Badge>;
    if (e === 'agotado') return <Badge variant="amber">Agotado</Badge>;
    return <Badge variant="gray">Inactivo</Badge>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nombre…" />
        </div>
        <select
          value={grupoId ?? ''}
          onChange={(e) => setGrupoId(e.target.value ? Number(e.target.value) : null)}
          style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14 }}
        >
          <option value="">Todos los grupos</option>
          {grupos.map((g) => (
            <option key={g.id} value={g.id}>{g.emoji ?? ''} {g.nombre}</option>
          ))}
        </select>
        <select
          value={estado}
          onChange={(e) => setEstado(e.target.value as EstadoFilter)}
          style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14 }}
        >
          <option value="todos">Todos</option>
          <option value="disponible">Disponibles</option>
          <option value="agotado">Agotados</option>
          <option value="inactivo">Inactivos</option>
        </select>
        <div style={{ flex: 1 }} />
        {puedeEditar && (
          <button
            type="button"
            onClick={() => setEditingItem('new')}
            style={{
              padding: '8px 16px', border: 'none', borderRadius: 6,
              background: '#2563EB', color: '#FFFFFF', cursor: 'pointer',
              fontSize: 14, fontWeight: 500,
            }}
          >+ Nuevo item</button>
        )}
      </div>

      {error && <div style={{ padding: 12, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, marginBottom: 12 }}>{error}</div>}

      <div style={{ overflowX: 'auto', border: '1px solid #E5E7EB', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead style={{ background: '#F9FAFB' }}>
            <tr>
              <th style={th}>Item</th>
              <th style={th}>Grupo</th>
              <th style={{ ...th, textAlign: 'right' }}>Precio</th>
              <th style={th}>Estado</th>
              <th style={th}>Visibilidad</th>
              <th style={th}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Cargando…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Sin items.</td></tr>
            )}
            {items.map((it) => (
              <tr key={it.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                <td style={td}>
                  <span style={{ marginRight: 6, fontSize: 18 }}>{it.emoji ?? '📦'}</span>
                  <strong>{it.nombre}</strong>
                  {it.descripcion && <div style={{ fontSize: 12, color: '#6B7280' }}>{it.descripcion}</div>}
                </td>
                <td style={td}>{it.grupo ? `${it.grupo.emoji ?? ''} ${it.grupo.nombre}` : <span style={{ color: '#9CA3AF' }}>—</span>}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatARS(it.precio_madre)}</td>
                <td style={td}>{badgeEstado(it.estado)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {it.visible_pos && <Badge variant="blue">POS</Badge>}
                    {it.visible_qr && <Badge variant="violet">QR</Badge>}
                    {it.visible_tienda && <Badge variant="green">Tienda</Badge>}
                  </div>
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {puedeEditar && (
                      <button type="button" onClick={() => setEditingItem(it)} style={btnSm}>Editar</button>
                    )}
                    {puedeEditar && it.estado === 'disponible' && (
                      <button type="button" onClick={() => setAgotarItem(it)} style={btnSm}>Agotar</button>
                    )}
                    {puedeEliminar && (
                      <button type="button" onClick={() => setConfirmDelete(it)} style={{ ...btnSm, color: '#DC2626' }}>Eliminar</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingItem !== null && (
        <ItemForm
          user={user}
          grupos={grupos}
          item={editingItem === 'new' ? null : editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={() => { setEditingItem(null); reload(); }}
        />
      )}
      {agotarItem && (
        <AgotarDialog
          item={agotarItem}
          onClose={() => setAgotarItem(null)}
          onDone={() => { setAgotarItem(null); reload(); }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Eliminar item"
        destructive
        message={confirmDelete ? <>¿Borrar <strong>{confirmDelete.nombre}</strong>? Se podrá restaurar después desde la base de datos (soft delete).</> : ''}
        confirmLabel="Eliminar"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          const { error: e } = await softDeleteItem(confirmDelete.id);
          if (e) setError(e);
          setConfirmDelete(null);
          reload();
        }}
      />
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'top' };
const btnSm: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer', fontSize: 12 };
