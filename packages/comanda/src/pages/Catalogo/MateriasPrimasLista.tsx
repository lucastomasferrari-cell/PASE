import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Search, Edit2, Trash2, Package, AlertCircle, Link2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  listMateriasPrimas, softDeleteMateriaPrima, calcCostoEfectivo,
  type MateriaPrima,
} from '@/services/materiasPrimasService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/Badge';
import { formatARS } from '@/lib/format';
import { useDebouncedValue } from '@pase/shared/utils';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { MateriaPrimaEditorDialog } from '@/components/dialogs/MateriaPrimaEditorDialog';

// Catálogo de materias primas: lo que se compra del proveedor.
// Vincula a un insumo unificado. Su costo_efectivo (precio / (factor*(1-merma)))
// alimenta el costo_actual del insumo via trigger SQL.

export function MateriasPrimasLista() {
  const { user } = useAuth();
  const [materias, setMaterias] = useState<MateriaPrima[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MateriaPrima | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listMateriasPrimas({
      search: debouncedSearch.trim() || undefined,
    });
    setMaterias(data);
    setLoading(false);
  }, [debouncedSearch]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({ table: 'materias_primas', onChange: () => reload() });

  function handleNueva() {
    setEditing(null);
    setEditorOpen(true);
  }
  function handleEditar(mp: MateriaPrima) {
    setEditing(mp);
    setEditorOpen(true);
  }
  async function handleEliminar(mp: MateriaPrima) {
    if (!confirm(`¿Eliminar "${mp.nombre}"? El costo del insumo se recalculará sin esta materia prima.`)) return;
    const { error } = await softDeleteMateriaPrima(mp.id);
    if (error) toast.error(error);
    else { toast.success('Eliminada'); reload(); }
  }

  if (!user?.tenant_id) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Materias primas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Lo que comprás del proveedor. Cada materia prima se vincula a un insumo unificado.
            El costo del insumo se recalcula automático al cargar facturas.
          </p>
        </div>
        <Button onClick={handleNueva}>
          <Plus className="h-4 w-4 mr-1.5" />
          Nueva materia prima
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
          {loading ? 'Cargando…' : `${materias.length} materia${materias.length === 1 ? '' : 's'} prima${materias.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : materias.length === 0 ? (
            <div className="py-12 text-center">
              <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground mb-3">
                {search ? `Sin resultados para "${search}"` : 'No hay materias primas cargadas.'}
              </p>
              {!search && (
                <Button variant="outline" onClick={handleNueva}>
                  <Plus className="h-4 w-4 mr-1.5" />
                  Crear la primera
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Materia prima</th>
                    <th className="text-left px-4 py-2.5">→ Insumo unificado</th>
                    <th className="text-left px-4 py-2.5">Proveedor</th>
                    <th className="text-right px-4 py-2.5">Precio compra</th>
                    <th className="text-right px-4 py-2.5">Factor</th>
                    <th className="text-right px-4 py-2.5">Merma</th>
                    <th className="text-right px-4 py-2.5">Costo efectivo</th>
                    <th className="text-center px-4 py-2.5">Estado</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {materias.map((mp) => {
                    const costoEf = calcCostoEfectivo(mp);
                    return (
                      <tr key={mp.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="font-medium">{mp.nombre}</div>
                          {mp.notas && <div className="text-xs text-muted-foreground truncate max-w-xs">{mp.notas}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 text-xs">
                            <Link2 className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium">{mp.insumo_nombre ?? `#${mp.insumo_id}`}</span>
                            {mp.insumo_unidad && <span className="text-muted-foreground">({mp.insumo_unidad})</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{mp.proveedor_nombre ?? '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {mp.precio_actual ? (
                            <>
                              {formatARS(mp.precio_actual)}
                              <div className="text-[10px] text-muted-foreground">/ {mp.unidad_compra}</div>
                            </>
                          ) : (
                            <span className="italic text-muted-foreground text-xs">sin cargar</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-xs">
                          {Number(mp.factor_conversion).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-xs">
                          {Number(mp.merma_pct).toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {costoEf ? formatARS(costoEf) : (
                            <span className="italic text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {mp.activa ? (
                            <Badge variant="green">Activa</Badge>
                          ) : (
                            <Badge variant="gray">Inactiva</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => handleEditar(mp)}>
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleEliminar(mp)} className="text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
        <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div>
          <strong>Cómo funciona:</strong> el <em>costo efectivo</em> = precio compra ÷ (factor × (1 − merma)).
          Ej: 1kg de trucha c/vísceras a $10.000 con merma 35% → costo efectivo = $10.000 / 0.65 = $15.385/kg.
          El insumo unificado promedia los costos efectivos de sus materias primas activas.
        </div>
      </div>

      {editorOpen && (
        <MateriaPrimaEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          tenantId={user.tenant_id}
          editing={editing}
          onSaved={() => { reload(); setEditorOpen(false); }}
        />
      )}
    </div>
  );
}
