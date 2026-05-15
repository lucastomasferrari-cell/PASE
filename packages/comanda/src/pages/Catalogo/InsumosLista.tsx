import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listInsumos, softDeleteInsumo, toggleStockInsumo } from '@/services/insumosService';
import type { Insumo } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatARS } from '@/lib/format';
import { InsumoEditorDialog } from '@/components/dialogs/InsumoEditorDialog';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

// F1.1b — Lista de insumos del tenant (paleta internal heredada de AdminLayout).
// Base para construir recetas con cantidad + merma %.
// El cost_actual queda en NULL hasta que (a) el dueño lo carga manual, o
// (b) Fase 1.2 PASE (vincular factura_items.insumo_id) lo llene automático.

export function InsumosLista() {
  const { user } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Insumo | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await listInsumos({ search: debouncedSearch.trim() || undefined });
    if (r.error) toast.error(r.error);
    else setInsumos(r.data);
    setLoading(false);
  }, [debouncedSearch]);

  useEffect(() => { reload(); }, [reload]);

  const handleNuevo = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const handleEditar = (insumo: Insumo) => {
    setEditing(insumo);
    setEditorOpen(true);
  };
  const handleEliminar = async (insumo: Insumo) => {
    if (!confirm(`¿Eliminar insumo "${insumo.nombre}"?`)) return;
    const r = await softDeleteInsumo(insumo.id);
    if (r.error) toast.error(r.error);
    else { toast.success('Insumo eliminado'); reload(); }
  };

  if (!tenantId) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Insumos</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Catálogo de ingredientes. Base para recetas y cálculo de CMV.
          </p>
        </div>
        <Button onClick={handleNuevo}>
          <Plus className="h-4 w-4 mr-1.5" />
          Nuevo insumo
        </Button>
      </header>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="ml-auto text-sm text-muted-foreground">
          {loading ? 'Cargando…' : `${insumos.length} insumo${insumos.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : insumos.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground mb-3">
                {search ? `No hay insumos que matcheen "${search}"` : 'No hay insumos cargados.'}
              </p>
              {!search && (
                <Button variant="outline" onClick={handleNuevo}>
                  <Plus className="h-4 w-4 mr-1.5" />
                  Crear el primero
                </Button>
              )}
            </div>
          ) : (
            <table className="w-full">
              <thead className="border-b bg-muted/30">
                <tr>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Nombre</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Unidad</th>
                  <th className="text-right text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Costo / unidad</th>
                  <th className="text-center text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground" title="Auto-86: items con receta que usen este insumo se marcan agotados">Stock</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Actualizado</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {insumos.map((i) => (
                  <tr
                    key={i.id}
                    className="hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => handleEditar(i)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {i.emoji && <span className="text-base">{i.emoji}</span>}
                        <div>
                          <div className="font-medium text-sm">{i.nombre}</div>
                          {i.descripcion && <div className="text-xs text-muted-foreground">{i.descripcion}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{i.unidad}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-right">
                      {i.costo_actual != null ? formatARS(Number(i.costo_actual)) : (
                        <span className="italic text-muted-foreground">sin cargar</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const nuevo = !(i.stock_disponible ?? true);
                          const accion = nuevo ? 'Reactivar' : 'Marcar SIN STOCK';
                          if (!nuevo && !confirm(`¿${accion} "${i.nombre}"? Los items con receta que lo usan se marcarán agotados.`)) return;
                          const { error } = await toggleStockInsumo(i.id, nuevo);
                          if (error) toast.error(error);
                          else { toast.success(nuevo ? 'Insumo disponible' : 'Items con receta marcados agotados'); reload(); }
                        }}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                          (i.stock_disponible ?? true)
                            ? 'bg-success/10 text-success hover:bg-success/20'
                            : 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                        }`}
                      >
                        {(i.stock_disponible ?? true) ? 'OK' : 'Sin stock'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {i.costo_actualizado_at
                        ? new Date(i.costo_actualizado_at).toLocaleDateString('es-AR')
                        : <span className="italic">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleEliminar(i); }}
                        className="text-destructive opacity-60 hover:opacity-100"
                      >
                        Eliminar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <InsumoEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        insumo={editing}
        tenantId={tenantId}
        onSaved={() => { setEditorOpen(false); reload(); }}
      />
    </div>
  );
}
