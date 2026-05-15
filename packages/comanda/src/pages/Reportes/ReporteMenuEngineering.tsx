import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, TrendingUp, HelpCircle, AlertTriangle, BookOpen } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/Badge';
import { formatARS } from '@/lib/format';
import {
  getMenuEngineering, downloadCSV,
  type MenuEngineeringItem, type MenuEngineeringCuadrante,
} from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

// Menu Engineering — feature Toast adaptada a AR.
// Cruza popularidad (cantidad vendida) vs margen (precio - costo de receta
// viva) y clasifica items en 4 cuadrantes:
//   star      → mantener / promocionar (alta-pop + alto-margen)
//   plowhorse → subir precio o bajar costo (alta-pop + bajo-margen)
//   puzzle    → mejor visibilidad / cross-sell (baja-pop + alto-margen)
//   dog       → sacar del menú o rediseñar (baja-pop + bajo-margen)
//   sin_receta → cargar receta en F1.1b para clasificar
//
// Threshold: mediana de popularidad + mediana de margen (robusto a outliers).

interface CuadranteInfo {
  label: string;
  descripcion: string;
  icon: typeof Star;
  color: string;
  bgColor: string;
  borderColor: string;
}

const CUADRANTES: Record<MenuEngineeringCuadrante, CuadranteInfo> = {
  star: {
    label: 'Star',
    descripcion: 'Alta venta, alto margen. Tu producto estrella — protegé la receta y la calidad.',
    icon: Star,
    color: 'text-amber-700 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-950/40',
    borderColor: 'border-amber-300 dark:border-amber-800',
  },
  plowhorse: {
    label: 'Plowhorse',
    descripcion: 'Se vende mucho pero gana poco. Considerá subir el precio o bajar el costo de la receta.',
    icon: TrendingUp,
    color: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/40',
    borderColor: 'border-blue-300 dark:border-blue-800',
  },
  puzzle: {
    label: 'Puzzle',
    descripcion: 'Buen margen pero no se vende. Mejorá visibilidad: foto, ubicación en carta, sugerencia del mozo.',
    icon: HelpCircle,
    color: 'text-violet-700 dark:text-violet-400',
    bgColor: 'bg-violet-50 dark:bg-violet-950/40',
    borderColor: 'border-violet-300 dark:border-violet-800',
  },
  dog: {
    label: 'Dog',
    descripcion: 'Baja venta, bajo margen. Candidato a sacar del menú o rediseñar receta + precio.',
    icon: AlertTriangle,
    color: 'text-rose-700 dark:text-rose-400',
    bgColor: 'bg-rose-50 dark:bg-rose-950/40',
    borderColor: 'border-rose-300 dark:border-rose-800',
  },
  sin_receta: {
    label: 'Sin receta',
    descripcion: 'No se puede clasificar hasta que cargues una receta en Menú → Insumos / Recetas.',
    icon: BookOpen,
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/40',
    borderColor: 'border-border',
  },
  sin_clasificar: {
    label: 'Sin clasificar',
    descripcion: 'Pocos datos en el período — necesitamos más ventas con receta cargada para calcular las medianas.',
    icon: HelpCircle,
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/40',
    borderColor: 'border-border',
  },
};

const CUADRANTE_ORDER: MenuEngineeringCuadrante[] = ['star', 'plowhorse', 'puzzle', 'dog', 'sin_receta', 'sin_clasificar'];

export function ReporteMenuEngineering() {
  const ctx = useReportesCtx();
  const [data, setData] = useState<MenuEngineeringItem[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    const { data } = await getMenuEngineering(ctx.localId, ctx.desde, ctx.hasta);
    setData(data);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    scopeByLocal: true,
    debounceMs: 5000,
    enabled: !!ctx.localId,
  });

  useEffect(() => {
    ctx.exportRef.current = () => {
      const headers = ['Item', 'Cuadrante', 'Cant. vendida', 'Total facturado', 'Precio prom.', 'Costo porción', 'Margen $', 'Margen %'];
      const rows = data.map(d => [
        d.nombre,
        CUADRANTES[d.cuadrante]?.label ?? d.cuadrante,
        Number(d.cantidad_vendida).toFixed(2),
        Number(d.total_facturado).toFixed(2),
        Number(d.precio_promedio).toFixed(2),
        d.costo_porcion == null ? '' : Number(d.costo_porcion).toFixed(2),
        d.margen_unitario == null ? '' : Number(d.margen_unitario).toFixed(2),
        d.margen_pct == null ? '' : Number(d.margen_pct).toFixed(1) + '%',
      ]);
      downloadCSV('menu-engineering.csv', headers, rows);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, data]);

  const grouped = useMemo(() => {
    const m = new Map<MenuEngineeringCuadrante, MenuEngineeringItem[]>();
    for (const cuadrante of CUADRANTE_ORDER) m.set(cuadrante, []);
    for (const item of data) {
      const list = m.get(item.cuadrante) ?? [];
      list.push(item);
      m.set(item.cuadrante, list);
    }
    return m;
  }, [data]);

  if (loading) return <Skeleton className="h-96 w-full" />;

  if (data.length === 0) {
    return (
      <div className="rounded-md border border-border p-12 text-center">
        <div className="text-5xl mb-2">🍽️</div>
        <p className="text-sm font-medium">Sin items vendidos en el período</p>
        <p className="text-xs text-muted-foreground mt-2">
          Probá ampliar el rango — necesitamos al menos algunas ventas para calcular el cuadrante.
        </p>
      </div>
    );
  }

  // Conteo por cuadrante (para chips arriba)
  const counts = CUADRANTE_ORDER.map(c => ({ c, n: grouped.get(c)?.length ?? 0 })).filter(x => x.n > 0);

  return (
    <div className="space-y-4">
      {/* Resumen de cuadrantes */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {counts.map(({ c, n }) => {
          const info = CUADRANTES[c];
          const Icon = info.icon;
          return (
            <div
              key={c}
              className={cn('rounded-md border p-3', info.bgColor, info.borderColor)}
            >
              <div className="flex items-center gap-1.5">
                <Icon className={cn('h-4 w-4', info.color)} />
                <span className={cn('text-xs font-semibold uppercase tracking-wide', info.color)}>
                  {info.label}
                </span>
              </div>
              <div className="text-2xl font-bold tabular-nums mt-1">{n}</div>
              <div className="text-[10px] text-muted-foreground">items</div>
            </div>
          );
        })}
      </div>

      {/* Tabla por cuadrante */}
      {CUADRANTE_ORDER.map(c => {
        const items = grouped.get(c) ?? [];
        if (items.length === 0) return null;
        const info = CUADRANTES[c];
        const Icon = info.icon;
        return (
          <Card key={c} className={cn('overflow-hidden border', info.borderColor)}>
            <div className={cn('px-4 py-3 border-b flex items-start gap-3', info.bgColor, info.borderColor)}>
              <Icon className={cn('h-5 w-5 mt-0.5 flex-shrink-0', info.color)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className={cn('text-sm font-semibold uppercase tracking-wide', info.color)}>
                    {info.label}
                  </h2>
                  <Badge variant="gray">{items.length}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{info.descripcion}</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Item</th>
                    <th className="text-right px-3 py-2">Cant.</th>
                    <th className="text-right px-3 py-2">Facturado</th>
                    <th className="text-right px-3 py-2">Precio prom.</th>
                    <th className="text-right px-3 py-2">Costo</th>
                    <th className="text-right px-3 py-2">Margen $</th>
                    <th className="text-right px-3 py-2">Margen %</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.item_id} className="border-t border-border">
                      <td className="px-3 py-2">
                        {item.emoji && <span className="mr-1">{item.emoji}</span>}
                        {item.nombre}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(item.cantidad_vendida).toFixed(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatARS(item.total_facturado)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatARS(item.precio_promedio)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {item.costo_porcion == null ? '—' : formatARS(item.costo_porcion)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {item.margen_unitario == null ? '—' : formatARS(item.margen_unitario)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.margen_pct == null ? '—' : Number(item.margen_pct).toFixed(1) + '%'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
