import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, AlertCircle, Image as ImageIcon, Tag, DollarSign, ChefHat, Receipt, FileText, Pencil, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  listItemsReview, marcarItemRevisado, desmarcarItemRevisado,
  type ItemReviewRow,
} from '@/services/itemReviewService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

// Sprint 2 competitor F #10 — Item review queue.
// Lista items "incompletos" (sin foto, sin grupo, sin precio, sin receta...)
// que se generaron por OCR/import/carga rápida. Con score de completitud y
// flags individuales. El manager los revisa, completa, y marca como ok.

interface FlagDef {
  key: 'falta_visual' | 'falta_grupo' | 'falta_precio' | 'falta_estacion' | 'falta_tax' | 'falta_receta' | 'falta_descripcion';
  label: string;
  icon: typeof ImageIcon;
  tone: string;
}

const FLAGS: FlagDef[] = [
  { key: 'falta_visual',      label: 'Sin foto/emoji', icon: ImageIcon, tone: 'text-amber-700 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-200' },
  { key: 'falta_grupo',       label: 'Sin grupo',      icon: Tag,       tone: 'text-blue-700 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-200' },
  { key: 'falta_precio',      label: 'Sin precio',     icon: DollarSign, tone: 'text-red-700 bg-red-100 dark:bg-red-900/30 dark:text-red-200' },
  { key: 'falta_estacion',    label: 'Sin estación KDS', icon: ChefHat, tone: 'text-purple-700 bg-purple-100 dark:bg-purple-900/30 dark:text-purple-200' },
  { key: 'falta_tax',         label: 'Sin IVA',        icon: Receipt,   tone: 'text-orange-700 bg-orange-100 dark:bg-orange-900/30 dark:text-orange-200' },
  { key: 'falta_receta',      label: 'Sin receta CMV', icon: ChefHat,   tone: 'text-teal-700 bg-teal-100 dark:bg-teal-900/30 dark:text-teal-200' },
  { key: 'falta_descripcion', label: 'Sin descripción', icon: FileText, tone: 'text-muted-foreground bg-muted' },
];

export function ItemReviewQueue() {
  const { user } = useAuth();
  const tenantId = user?.tenant_id ?? null;
  const navigate = useNavigate();

  const [items, setItems] = useState<ItemReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResueltos, setShowResueltos] = useState(false);
  const [actuando, setActuando] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const r = await listItemsReview(tenantId, { soloNoRevisados: !showResueltos });
    if (r.error) toast.error(r.error);
    else setItems(r.data);
    setLoading(false);
  }, [tenantId, showResueltos]);

  useEffect(() => { reload(); }, [reload]);

  // Estadísticas del bucket
  const stats = useMemo(() => {
    let criticos = 0, medios = 0, completos = 0;
    for (const it of items) {
      if (it.score_completitud < 50) criticos++;
      else if (it.score_completitud < 80) medios++;
      else completos++;
    }
    return { total: items.length, criticos, medios, completos };
  }, [items]);

  async function handleMarcar(itemId: number) {
    setActuando(itemId);
    const { error } = await marcarItemRevisado(itemId);
    setActuando(null);
    if (error) { toast.error(error); return; }
    toast.success('Item marcado como revisado');
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  }

  async function handleDesmarcar(itemId: number) {
    setActuando(itemId);
    const { error } = await desmarcarItemRevisado(itemId);
    setActuando(null);
    if (error) { toast.error(error); return; }
    toast.success('Item devuelto a la cola');
    reload();
  }

  if (!tenantId) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <AlertCircle className="h-6 w-6 text-warning" />
          Items por revisar
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Items que se cargaron rápido y les faltan datos (foto, grupo, precio, estación KDS, receta CMV).
          Completalos para que reportes y operación queden completos.
        </p>
      </header>

      {/* Stats */}
      <div className="mb-4 grid grid-cols-3 sm:grid-cols-3 gap-2">
        <StatCard label="Críticos (<50)" value={stats.criticos} tone="destructive" />
        <StatCard label="Medios (50-79)" value={stats.medios} tone="warning" />
        <StatCard label={showResueltos ? 'Revisados' : 'Casi OK (80+)'} value={stats.completos} tone="success" />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Button
          variant={!showResueltos ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowResueltos(false)}
        >
          Pendientes ({items.length === 0 && !showResueltos ? '0' : stats.total})
        </Button>
        <Button
          variant={showResueltos ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowResueltos(true)}
        >
          Ver revisados
        </Button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Cargando…</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-success" />
            <p className="font-medium">
              {showResueltos ? 'Sin items revisados todavía' : '¡Todo en orden!'}
            </p>
            <p className="text-xs mt-1">
              {showResueltos
                ? 'Cuando marques items como revisados, van a aparecer acá.'
                : 'No hay items pendientes de revisión.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <ItemReviewCard
              key={it.id}
              item={it}
              actuando={actuando === it.id}
              onEditar={() => navigate('/menu/items')}
              onMarcar={() => handleMarcar(it.id)}
              onDesmarcar={() => handleDesmarcar(it.id)}
              modoRevisados={showResueltos}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'destructive' | 'warning' | 'success' }) {
  const toneClass = {
    destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
    warning: 'border-warning/30 bg-warning/5 text-warning',
    success: 'border-success/30 bg-success/5 text-success',
  }[tone];
  return (
    <div className={cn('rounded-md border p-2.5', toneClass)}>
      <div className="text-[10px] uppercase tracking-wide font-medium opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function ItemReviewCard({ item, actuando, onEditar, onMarcar, onDesmarcar, modoRevisados }: {
  item: ItemReviewRow;
  actuando: boolean;
  onEditar: () => void;
  onMarcar: () => void;
  onDesmarcar: () => void;
  modoRevisados: boolean;
}) {
  const flagsActivas = FLAGS.filter((f) => item[f.key]);
  const scoreColor =
    item.score_completitud >= 80 ? 'text-success' :
    item.score_completitud >= 50 ? 'text-warning' :
    'text-destructive';

  return (
    <Card>
      <CardContent className="p-3.5">
        <div className="flex items-start gap-3 flex-wrap">
          {/* Visual del item */}
          <div className="shrink-0 h-14 w-14 rounded-md bg-muted flex items-center justify-center overflow-hidden">
            {item.foto_url ? (
              <img src={item.foto_url} alt="" className="w-full h-full object-cover" />
            ) : item.emoji ? (
              <div className="text-3xl">{item.emoji}</div>
            ) : (
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-1 flex-wrap">
              <span className="font-semibold text-sm">{item.nombre}</span>
              <span className={cn('text-xs font-bold tabular-nums', scoreColor)}>
                {item.score_completitud}/100
              </span>
              {item.precio_madre > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatARS(item.precio_madre)}
                </span>
              )}
            </div>
            {flagsActivas.length === 0 ? (
              <div className="text-xs text-success inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Sin issues — pero todavía en cola
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {flagsActivas.map((f) => {
                  const Icon = f.icon;
                  return (
                    <span
                      key={f.key}
                      className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', f.tone)}
                    >
                      <Icon className="h-2.5 w-2.5" />
                      {f.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1 shrink-0">
            <Button size="sm" variant="outline" disabled={actuando} onClick={onEditar}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Editar
            </Button>
            {modoRevisados ? (
              <Button size="sm" variant="ghost" disabled={actuando} onClick={onDesmarcar}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Devolver a cola
              </Button>
            ) : (
              <Button size="sm" variant="success" disabled={actuando} onClick={onMarcar}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Marcar OK
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
