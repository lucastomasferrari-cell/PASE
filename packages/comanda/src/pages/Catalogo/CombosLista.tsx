import { useEffect, useState, useCallback } from 'react';
import { Layers, Pencil, Package, Settings } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listCombos } from '@/services/combosService';
import { listItems } from '@/services/itemsService';
import type { Item } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatARS } from '@/lib/format';
// useRealtimeTable sacado sprint optim egress 2026-05-16
import { ComboEditorDialog } from '@/components/dialogs/ComboEditorDialog';
import { useCatalogoScope, scopeToItemsFilter } from '@/lib/catalogoScope';
import { CatalogoScopeSelector } from '@/components/CatalogoScopeSelector';

// Lista de combos. Un "combo" es un item del catálogo con es_combo=true.
// Su composición se define en combo_componentes (slots con items elegibles).
//
// Esta pantalla:
//   - Lista items donde es_combo=true
//   - Muestra cuántos slots tiene cada combo
//   - Botón "Configurar" abre ComboEditorDialog
//
// El item base se crea desde Items (con toggle es_combo). Acá solo se
// configura la composición.

export function CombosLista() {
  const { user } = useAuth();
  const [combos, setCombos] = useState<Item[]>([]);
  const [todosItems, setTodosItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Item | null>(null);
  const [scope] = useCatalogoScope();

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    // Alcance: combos + items elegibles del maestro o de la sucursal (deben ser
    // del mismo alcance para que los slots referencien items existentes).
    const scopeFilter = scopeToItemsFilter(scope);
    const [combosRes, itemsRes] = await Promise.all([
      listCombos(user.tenant_id, scopeFilter),
      listItems({ tenantId: user.tenant_id, ...scopeFilter }),
    ]);
    setCombos(combosRes.data);
    // Items disponibles para slots (los NO-combo)
    setTodosItems(itemsRes.data.filter((i) => !i.es_combo));
    setLoading(false);
  }, [user?.tenant_id, scope]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime SACADO sprint optimización egress 2026-05-16. Combos se
  // configuran 1 vez al armar el menú. F5 manual cubre el caso edge.

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6" />
            Combos {scope === 'maestro' ? '· maestro' : '· sucursal'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {combos.length} combo{combos.length === 1 ? '' : 's'} configurado{combos.length === 1 ? '' : 's'} ·
            Un combo agrupa items en "slots" (Bebida, Acompañamiento, etc.) — el cliente arma su pedido eligiendo dentro de cada slot.
          </p>
        </div>
        <CatalogoScopeSelector />
      </header>

      {/* Banner explicativo */}
      <Card className="mb-4 border-primary/30 bg-primary/5">
        <CardContent className="p-4 text-sm space-y-1">
          <div className="font-medium text-primary flex items-center gap-2">
            <Package className="h-4 w-4" />
            Cómo crear un combo
          </div>
          <ol className="text-xs text-muted-foreground space-y-0.5 list-decimal list-inside ml-4">
            <li>Andá a <strong>Menú → Items</strong> y creá un item nuevo (ej: "Combo Hamburguesa").</li>
            <li>Activá el toggle <strong>"Es combo"</strong> al final del formulario y guardá.</li>
            <li>Volvé acá, encontralo en la lista y tocá <strong>"Configurar"</strong> para definir slots y opciones.</li>
          </ol>
        </CardContent>
      </Card>

      {loading ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : combos.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Layers className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-1">Sin combos aún</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Creá un item con "es_combo" activado desde Menú → Items para empezar.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {combos.map((combo) => (
            <ComboCard
              key={combo.id}
              combo={combo}
              onConfigurar={() => setEditing(combo)}
            />
          ))}
        </div>
      )}

      {editing && (
        <ComboEditorDialog
          combo={editing}
          itemsDisponibles={todosItems}
          tenantId={user?.tenant_id ?? ''}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function ComboCard({ combo, onConfigurar }: { combo: Item; onConfigurar: () => void }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="h-12 w-12 rounded-md bg-primary/10 flex items-center justify-center text-2xl shrink-0">
            {combo.emoji ?? '📦'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{combo.nombre}</div>
            {combo.descripcion && (
              <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{combo.descripcion}</div>
            )}
            <div className="text-lg font-bold tabular-nums mt-1">{formatARS(combo.precio_madre)}</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">
            Estado: <strong className="text-foreground">{combo.estado}</strong>
          </span>
          {!combo.visible_pos && <span className="px-2 py-0.5 rounded bg-warning/10 text-warning">No visible POS</span>}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={onConfigurar}>
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            Configurar slots
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href="/menu/items" title="Editar datos del item base">
              <Pencil className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
