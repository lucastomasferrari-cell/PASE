import { useEffect, useState, useCallback } from 'react';
import { Search, Plus, Pencil, Ban, Trash2, Package, Download } from 'lucide-react';
import type { Usuario } from '@/types/auth';
import type { ItemConGrupo } from '@/services/itemsService';
import { listItems, softDeleteItem } from '@/services/itemsService';
import { listGrupos } from '@/services/gruposService';
import { listMarcas, type MarcaLite } from '@/services/marcasService';
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
import type { CatalogoScope } from '@/lib/catalogoScope';
import { useCatalogoScope, scopeToItemsFilter, scopeLocalId } from '@/lib/catalogoScope';
import { CatalogoScopeSelector } from '@/components/CatalogoScopeSelector';
import { ItemForm } from './ItemForm';
import { AgotarDialog } from './AgotarDialog';
import { ImportarMenuDialog } from './ImportarMenuDialog';
// useRealtimeTable sacado sprint optim egress 2026-05-16

interface Props {
  user: Usuario;
  /**
   * Si viene, el tab bloquea el scope a ese valor y oculta el CatalogoScopeSelector.
   * Se usa en las rutas /menu/maestro/* para forzar el editor a "maestro"
   * (rutas dueño-only) mientras que las rutas /menu/* siguen funcionando con el
   * selector de sucursal. Sin este prop, se comporta como antes (con selector).
   */
  forceScope?: CatalogoScope;
}

type EstadoFilter = ItemEstado | 'todos';

export function ItemsTab({ user, forceScope }: Props) {
  const [items, setItems] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [marcas, setMarcas] = useState<MarcaLite[]>([]);
  const [marcaFilter, setMarcaFilter] = useState<string>('todas');
  const [search, setSearch] = useState('');
  const [grupoFilter, setGrupoFilter] = useState<string>('todos');
  const [estadoFilter, setEstadoFilter] = useState<EstadoFilter>('todos');
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState<ItemConGrupo | 'new' | null>(null);
  const [agotarItem, setAgotarItem] = useState<ItemConGrupo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemConGrupo | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hookScope] = useCatalogoScope();
  const scope = forceScope ?? hookScope;

  const puedeEditar = tienePermiso(user, 'comanda.catalogo.editar');
  const puedeEliminar = tienePermiso(user, 'comanda.catalogo.eliminar');

  const marcaIdFiltro = marcaFilter === 'todas' ? null : Number(marcaFilter);

  const reload = useCallback(async () => {
    setLoading(true);
    const grupoIdNum = grupoFilter === 'todos' ? null : Number(grupoFilter);
    const marcaIdNum = marcaFilter === 'todas' ? null : Number(marcaFilter);
    // Modelo maestro+import: el alcance (scope) decide qué menú editás — el
    // MAESTRO de la marca (local_id NULL) o la copia de una SUCURSAL puntual.
    const scopeFilter = scopeToItemsFilter(scope);
    const [itemsRes, gruposRes] = await Promise.all([
      listItems({ search, grupoId: grupoIdNum, estado: estadoFilter, marcaId: marcaIdNum, ...scopeFilter, tenantId: user.tenant_id }),
      listGrupos(user.tenant_id, marcaIdNum, scopeFilter),
    ]);
    if (itemsRes.error) setError(itemsRes.error);
    setItems(itemsRes.data);
    setGrupos(gruposRes.data);
    setLoading(false);
  }, [search, grupoFilter, estadoFilter, marcaFilter, scope, user.tenant_id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Marcas: se cargan una vez (no dependen de filtros).
  useEffect(() => {
    listMarcas(user.tenant_id).then((r) => setMarcas(r.data));
  }, [user.tenant_id]);

  // Realtime SACADO sprint optimización egress 2026-05-16. Tabla master,
  // se edita poco, no necesita refresh inter-tab. El propio save del form
  // dispara reload() — alcanza para single-user workflow.
  // Si 2 admins editan items en paralelo, F5 manual cubre el caso edge.

  const hasFilters = search !== '' || grupoFilter !== 'todos' || estadoFilter !== 'todos';

  return (
    <div className="container py-6">
      {/* Header con título + CTA */}
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {scope === 'maestro' ? 'Menú maestro de la marca' : 'Menú de la sucursal'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {scope === 'maestro'
              ? `${items.length} ${items.length === 1 ? 'item' : 'items'} · plantilla que cada sucursal importa y edita`
              : `${items.length} ${items.length === 1 ? 'item' : 'items'} · copia editable de esta sucursal`}
          </p>
        </div>
        {puedeEditar && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Si el scope viene forzado (rutas /menu/maestro/*), no mostramos
                el selector — el usuario está en la sección de marca dedicada y
                el alcance está fijo en 'maestro'. En rutas /menu/* (sucursal),
                el selector no muestra la opción 'maestro' (hideMaestro). */}
            {!forceScope && <CatalogoScopeSelector hideMaestro />}
            {scope === 'maestro' && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Download className="h-4 w-4 mr-1.5" />
                Importar a sucursal
              </Button>
            )}
            <Button onClick={() => setEditingItem('new')}>
              <Plus className="h-4 w-4 mr-1.5" />
              Nuevo item
            </Button>
          </div>
        )}
      </header>

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
        {marcas.length > 0 && (
          <Select value={marcaFilter} onValueChange={setMarcaFilter}>
            <SelectTrigger className="w-[200px] h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas las marcas</SelectItem>
              {marcas.map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>{m.nombre}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
          marcas={marcas}
          defaultMarcaId={marcaIdFiltro}
          scopeLocalId={scopeLocalId(scope)}
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

      <ImportarMenuDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        marcas={marcas}
      />
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
