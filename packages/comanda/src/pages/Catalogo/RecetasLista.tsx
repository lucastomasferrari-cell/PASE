import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, ChefHat, AlertCircle, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listItemsConReceta, type ItemConReceta } from '@/services/recetasService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatARS } from '@/lib/format';
import { RecetaEditorDialog } from '@/components/dialogs/RecetaEditorDialog';

// F1.1b — Lista de items con su receta vigente (o sin receta).
// Click en un item abre el editor de receta para ese item.

export function RecetasLista() {
  const { user } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const [items, setItems] = useState<ItemConReceta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'with' | 'without'>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ItemConReceta | null>(null);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const r = await listItemsConReceta(tenantId);
    if (r.error) toast.error(r.error);
    else setItems(r.data);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = items.filter((it) => {
    if (search.trim()) {
      if (!it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
    }
    if (filter === 'with') return it.receta != null;
    if (filter === 'without') return it.receta == null;
    return true;
  });

  if (!tenantId) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Recetas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vinculá insumos a cada item del catálogo con cantidades y merma. Base para CMV.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/menu/recetas/importar">
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Importar desde CSV
          </Link>
        </Button>
      </header>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar item por nombre"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button variant={filter === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('all')}>
            Todos
          </Button>
          <Button variant={filter === 'with' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('with')}>
            Con receta
          </Button>
          <Button variant={filter === 'without' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('without')}>
            Sin receta
          </Button>
        </div>
        <div className="ml-auto text-sm text-muted-foreground">
          {loading ? 'Cargando…' : `${filtered.length} de ${items.length}`}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {search ? 'No hay items que matcheen' : 'Sin items en el catálogo'}
            </div>
          ) : (
            <table className="w-full">
              <thead className="border-b bg-muted/30">
                <tr>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Item</th>
                  <th className="text-right text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Precio</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Receta</th>
                  <th className="text-right text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Rendimiento</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((it) => (
                  <tr
                    key={it.id}
                    className="hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => { setEditingItem(it); setEditorOpen(true); }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {it.emoji && <span className="text-base">{it.emoji}</span>}
                        <span className="font-medium text-sm">{it.nombre}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-right">{formatARS(it.precio_madre)}</td>
                    <td className="px-4 py-3 text-sm">
                      {it.receta ? (
                        <div className="flex items-center gap-1.5">
                          <ChefHat className="h-3.5 w-3.5 text-success" />
                          <span className="font-medium">{it.receta.nombre}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-muted-foreground italic">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Sin receta
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-right">
                      {it.receta ? `${it.receta.rendimiento} porc.` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="outline" size="sm">
                        {it.receta ? 'Editar receta' : 'Crear receta'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <RecetaEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        item={editingItem}
        tenantId={tenantId}
        onSaved={() => { setEditorOpen(false); reload(); }}
      />
    </div>
  );
}
