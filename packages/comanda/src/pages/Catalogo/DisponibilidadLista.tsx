import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Search, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listItems, marcarDisponible, type ItemConGrupo } from '@/services/itemsService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { useDebouncedValue } from '@pase/shared/utils';
import { AgotarDialog } from './AgotarDialog';
import { cn } from '@/lib/utils';

// F1.x — Pantalla "86 list" (disponibilidad de items).
// Reemplaza el stub de /menu/disponibilidad.
//
// Diseño: 2 secciones lado a lado en desktop, stack en mobile.
//   - Izquierda: items disponibles (con CTA "Marcar agotado").
//   - Derecha: 86 list (agotados) con razón, quién, tiempo + CTA "Reactivar".
//
// Realtime: cuando otro cajero marca/desmarca, se refresca automático.

function relativoCorto(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const ahora = Date.now();
  const seg = Math.floor((ahora - d) / 1000);
  if (seg < 60) return 'hace un momento';
  if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`;
  if (seg < 86400) return `hace ${Math.floor(seg / 3600)} h`;
  return `hace ${Math.floor(seg / 86400)} d`;
}

export function DisponibilidadLista() {
  const { user } = useAuth();
  const tenantId = user?.tenant_id ?? null;
  // La lista de "86" es OPERATIVA por sucursal: mostrás/marcás agotado el menú
  // del local en el que estás trabajando (local activo del POS).
  const [localId] = useLocalActivo(user);

  const [items, setItems] = useState<ItemConGrupo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [agotarDialog, setAgotarDialog] = useState<ItemConGrupo | null>(null);

  const debouncedSearch = useDebouncedValue(search, 300);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const r = await listItems({ tenantId, localId, search: debouncedSearch.trim() || undefined });
    if (r.error) toast.error(r.error);
    else setItems(r.data);
    setLoading(false);
  }, [tenantId, localId, debouncedSearch]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime: cualquier cambio de items se refleja al toque.
  useRealtimeTable({ table: 'items', onChange: () => reload() });

  const disponibles = items.filter(i => i.estado === 'disponible');
  const agotados = items.filter(i => i.estado === 'agotado');

  const handleReactivar = async (item: ItemConGrupo) => {
    const r = await marcarDisponible(item.id);
    if (r.error) toast.error(r.error);
    else { toast.success(`"${item.nombre}" disponible de nuevo`); reload(); }
  };

  if (!tenantId) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Disponibilidad</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Items que están agotados aparecen tachados en el POS y bloqueados en pedidos online. Reactivá cuando vuelvan.
        </p>
      </header>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            <span className="text-muted-foreground">Disponibles: <strong className="text-foreground">{disponibles.length}</strong></span>
          </div>
          <div className="flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            <span className="text-muted-foreground">Agotados: <strong className="text-foreground">{agotados.length}</strong></span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* DISPONIBLES */}
        <Card>
          <CardContent className="p-0">
            <div className="px-4 py-2.5 border-b bg-success/10 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <h2 className="text-sm font-semibold">Disponibles ({disponibles.length})</h2>
            </div>
            {loading ? (
              <div className="py-8 text-center text-muted-foreground">Cargando…</div>
            ) : disponibles.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground italic">Sin items disponibles.</div>
            ) : (
              <ul className="divide-y max-h-[60vh] overflow-y-auto">
                {disponibles.map((it) => (
                  <li key={it.id} className="px-4 py-2.5 flex items-center gap-2 hover:bg-muted/30">
                    {it.emoji && <span className="text-base flex-shrink-0">{it.emoji}</span>}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{it.nombre}</div>
                      {it.grupo && <div className="text-xs text-muted-foreground">{it.grupo.nombre}</div>}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAgotarDialog(it)}
                      className="flex-shrink-0"
                    >
                      Marcar agotado
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 86 LIST */}
        <Card>
          <CardContent className="p-0">
            <div className="px-4 py-2.5 border-b bg-destructive/10 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <h2 className="text-sm font-semibold">86 List — agotados ({agotados.length})</h2>
            </div>
            {loading ? (
              <div className="py-8 text-center text-muted-foreground">Cargando…</div>
            ) : agotados.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground italic">No hay items agotados.</div>
            ) : (
              <ul className="divide-y max-h-[60vh] overflow-y-auto">
                {agotados.map((it) => (
                  <li key={it.id} className="px-4 py-2.5 hover:bg-muted/30">
                    <div className="flex items-start gap-2">
                      {it.emoji && <span className={cn('text-base flex-shrink-0', 'opacity-60')}>{it.emoji}</span>}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-1.5">
                          {it.nombre}
                          {it.agotado_motivo?.startsWith('Auto-86:') && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[9px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 uppercase tracking-wide">
                              Auto
                            </span>
                          )}
                        </div>
                        {it.agotado_motivo && (
                          <p className="text-xs text-muted-foreground italic mt-0.5">
                            "{it.agotado_motivo}"
                          </p>
                        )}
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                          <Clock className="h-3 w-3" />
                          {relativoCorto(it.agotado_at)}
                          {it.agotado_hasta && (
                            <span className="ml-2">→ vuelve {new Date(it.agotado_hasta).toLocaleDateString('es-AR')}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => handleReactivar(it)}
                        className="flex-shrink-0"
                      >
                        Reactivar
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dialog para marcar agotado */}
      {agotarDialog && (
        <AgotarDialog
          item={agotarDialog}
          onClose={() => setAgotarDialog(null)}
          onDone={() => { setAgotarDialog(null); reload(); }}
        />
      )}
    </div>
  );
}
