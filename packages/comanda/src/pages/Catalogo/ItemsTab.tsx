import { useEffect, useState, useCallback } from 'react';
import { Search, Plus, Pencil, Ban, Trash2, Package } from 'lucide-react';
import type { Usuario } from '@/types/auth';
import type { ItemConGrupo } from '@/services/itemsService';
import { listItems, softDeleteItem } from '@/services/itemsService';
import { listGrupos } from '@/services/gruposService';
import type { ItemGrupo, ItemEstado } from '@/types/database';
import { tienePermiso } from '@/lib/auth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatARS } from '@/lib/utils';
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
  const [grupoFilter, setGrupoFilter] = useState<string>('todos');
  const [estadoFilter, setEstadoFilter] = useState<EstadoFilter>('todos');
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState<ItemConGrupo | 'new' | null>(null);
  const [agotarItem, setAgotarItem] = useState<ItemConGrupo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemConGrupo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.catalogo.editar');
  const puedeEliminar = tienePermiso(user, 'comanda.catalogo.eliminar');

  const reload = useCallback(async () => {
    setLoading(true);
    const grupoIdNum = grupoFilter === 'todos' ? null : Number(grupoFilter);
    const [itemsRes, gruposRes] = await Promise.all([
      listItems({ search, grupoId: grupoIdNum, estado: estadoFilter, tenantId: user.tenant_id }),
      listGrupos(user.tenant_id),
    ]);
    if (itemsRes.error) setError(itemsRes.error);
    setItems(itemsRes.data);
    setGrupos(gruposRes.data);
    setLoading(false);
  }, [search, grupoFilter, estadoFilter, user.tenant_id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const hasFilters = search !== '' || grupoFilter !== 'todos' || estadoFilter !== 'todos';

  return (
    <div>
      {/* Header con CTA */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">
          {items.length} items
        </p>
        {puedeEditar && (
          <Button size="lg" onClick={() => setEditingItem('new')}>
            <Plus className="h-5 w-5" />
            Nuevo item
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Buscar por nombre…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-11"
          />
        </div>
        <Select value={grupoFilter} onValueChange={setGrupoFilter}>
          <SelectTrigger className="w-[200px] h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los grupos</SelectItem>
            {grupos.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>{g.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={estadoFilter} onValueChange={(v) => setEstadoFilter(v as EstadoFilter)}>
          <SelectTrigger className="w-[180px] h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            <SelectItem value="disponible">Disponibles</SelectItem>
            <SelectItem value="agotado">Agotados</SelectItem>
            <SelectItem value="inactivo">Inactivos</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Tabla / Empty state */}
      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : items.length === 0 ? (
        <EmptyState onNewItem={() => setEditingItem('new')} hasFilters={hasFilters} canEdit={puedeEditar} />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_140px_140px_180px_220px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Item</div>
            <div>Grupo</div>
            <div className="text-right">Precio</div>
            <div>Estado</div>
            <div>Visibilidad</div>
            <div className="text-right">Acciones</div>
          </div>
          {items.map((item, idx) => (
            <div
              key={item.id}
              className={`grid grid-cols-[2fr_1fr_140px_140px_180px_220px] gap-4 px-6 py-4 items-center transition-colors hover:bg-muted/30 ${
                idx !== items.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                  {item.emoji ? (
                    <span className="text-lg" aria-hidden>{item.emoji}</span>
                  ) : (
                    <Package className="h-5 w-5 text-primary" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="font-medium truncate">{item.nombre}</div>
                  {item.descripcion && (
                    <div className="text-sm text-muted-foreground truncate">{item.descripcion}</div>
                  )}
                </div>
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {item.grupo ? item.grupo.nombre : '—'}
              </div>
              <div className="text-right tabular-nums font-medium">
                {formatARS(item.precio_madre)}
              </div>
              <div>
                <EstadoBadge estado={item.estado} />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {item.visible_pos && <Badge variant="secondary" className="text-xs">POS</Badge>}
                {item.visible_qr && <Badge variant="secondary" className="text-xs">QR</Badge>}
                {item.visible_tienda && <Badge variant="secondary" className="text-xs">Tienda</Badge>}
              </div>
              <div className="flex justify-end gap-1">
                {puedeEditar && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingItem(item)}>
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Button>
                )}
                {puedeEditar && item.estado === 'disponible' && (
                  <Button variant="ghost" size="sm" onClick={() => setAgotarItem(item)}>
                    <Ban className="h-4 w-4" />
                    Agotar
                  </Button>
                )}
                {puedeEliminar && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmDelete(item)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Dialogs (mantienen design existente — fuera de scope sprint) */}
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

      {/* Confirm delete con shadcn Dialog */}
      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar item</DialogTitle>
            <DialogDescription>
              ¿Borrar <strong>{confirmDelete?.nombre}</strong>? Se podrá restaurar después
              desde la base de datos (soft delete).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancelar</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!confirmDelete) return;
                const { error: e } = await softDeleteItem(confirmDelete.id);
                if (e) setError(e);
                setConfirmDelete(null);
                reload();
              }}
            >Eliminar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EstadoBadge({ estado }: { estado: ItemEstado }) {
  if (estado === 'disponible') {
    return (
      <Badge variant="outline" className="bg-success/10 text-success border-success/20">
        Disponible
      </Badge>
    );
  }
  if (estado === 'agotado') {
    return (
      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
        Agotado
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
      Inactivo
    </Badge>
  );
}

function EmptyState({ onNewItem, hasFilters, canEdit }: { onNewItem: () => void; hasFilters: boolean; canEdit: boolean }) {
  if (hasFilters) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-1">No encontramos items</h3>
          <p className="text-sm text-muted-foreground">
            Probá con otros filtros o ajustá la búsqueda.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="py-16 text-center">
        <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-1">Sin items en el catálogo</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Empezá creando tu primer item para venderlo en el POS.
        </p>
        {canEdit && (
          <Button onClick={onNewItem}>
            <Plus className="h-5 w-5" />
            Crear primer item
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
