import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { TrendingDown, Check, X, DollarSign } from 'lucide-react';
import { listAlertasActivas, reconocerAlerta, type AlertaMargen, type AccionAlerta } from '@/services/alertasMargenService';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatARS } from '@/lib/format';

// Sprint 1 competitor F #4 — Alertas de margen por auto-recosting.
// Cuando el costo de un insumo sube y empuja el margen de la receta a la
// baja > 5pp, el trigger genera una fila acá. El dueño revisa, decide qué
// hacer y la reconoce. Tres acciones posibles:
//   - precio_actualizado: ya subí el precio del item, recupero margen
//   - asumido: dejo el margen menor (promo, item de gancho, etc.)
//   - dismiss: alerta espuria o irrelevante

export function AlertasMargenLista() {
  const [alertas, setAlertas] = useState<AlertaMargen[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconociendo, setReconociendo] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await listAlertasActivas();
    if (r.error) toast.error(r.error);
    else setAlertas(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function handleReconocer(alertaId: number, accion: AccionAlerta) {
    setReconociendo(alertaId);
    const { error } = await reconocerAlerta(alertaId, accion);
    setReconociendo(null);
    if (error) { toast.error(error); return; }
    toast.success('Alerta reconocida');
    setAlertas((prev) => prev.filter((a) => a.id !== alertaId));
  }

  return (
    <div className="container py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <TrendingDown className="h-6 w-6 text-warning" />
          Alertas de margen
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cuando sube el costo de un insumo, el margen de las recetas que lo usan baja.
          Acá ves qué items se vieron afectados y decidís: actualizar precio, asumir el margen menor o ignorar.
        </p>
      </header>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Cargando…</div>
      ) : alertas.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Check className="h-10 w-10 mx-auto mb-3 text-success" />
            <p className="font-medium">Sin alertas activas</p>
            <p className="text-xs mt-1">Cuando suba el costo de un insumo te avisamos acá.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {alertas.map((a) => (
            <Card key={a.id} className="border-warning/30">
              <CardContent className="p-4">
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{a.item_emoji ?? '🍽'}</span>
                      <Link
                        to={`/menu/recetas`}
                        className="font-semibold text-base hover:underline"
                        title="Ver receta"
                      >
                        {a.item_nombre}
                      </Link>
                      {a.caida_pp != null && (
                        <span className="text-xs px-2 py-0.5 rounded bg-warning/15 text-warning-foreground font-bold uppercase">
                          −{a.caida_pp}pp
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mb-2">
                      Disparado por{' '}
                      <Link to="/menu/insumos" className="underline">
                        {a.trigger_insumo_nombre ?? 'insumo'}
                      </Link>
                      {' · '}
                      {new Date(a.created_at).toLocaleString('es-AR')}
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <Metric label="Precio actual" value={formatARS(a.precio_actual)} />
                      <Metric
                        label="Costo"
                        value={`${formatARS(a.costo_anterior)} → ${formatARS(a.costo_nuevo)}`}
                        warning
                      />
                      <Metric
                        label="Margen"
                        value={
                          a.margen_anterior_pct != null && a.margen_nuevo_pct != null
                            ? `${a.margen_anterior_pct}% → ${a.margen_nuevo_pct}%`
                            : '—'
                        }
                        warning
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 min-w-[160px]">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={reconociendo === a.id}
                      onClick={() => handleReconocer(a.id, 'precio_actualizado')}
                    >
                      <DollarSign className="h-3.5 w-3.5 mr-1" />
                      Subí el precio
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reconociendo === a.id}
                      onClick={() => handleReconocer(a.id, 'asumido')}
                    >
                      Asumir margen menor
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={reconociendo === a.id}
                      onClick={() => handleReconocer(a.id, 'dismiss')}
                    >
                      <X className="h-3.5 w-3.5 mr-1" />
                      Ignorar
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${warning ? 'text-warning' : 'text-foreground'}`}>
        {value}
      </div>
    </div>
  );
}
