import { useCallback, useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import {
  getKpisPeriodo, getTopProductos, getVentasPorCanal, getTiempos,
  downloadCSV,
  type KpisPeriodo, type TopProducto, type VentasPorCanal, type TiemposReporte,
} from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

function fmtSeg(s: number | null | undefined): string {
  if (s == null) return '—';
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function Dashboard() {
  const ctx = useReportesCtx();
  const [kpis, setKpis] = useState<KpisPeriodo | null>(null);
  // Comparativo: KPIs del período anterior de igual duración (filosofía #7).
  const [kpisAnterior, setKpisAnterior] = useState<KpisPeriodo | null>(null);
  const [topProds, setTopProds] = useState<TopProducto[]>([]);
  const [ventasCanal, setVentasCanal] = useState<VentasPorCanal[]>([]);
  const [tiempos, setTiempos] = useState<TiemposReporte | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    // Período anterior = mismo tamaño que el actual, justo antes.
    const desdeMs = new Date(ctx.desde).getTime();
    const hastaMs = new Date(ctx.hasta).getTime();
    const dur = hastaMs - desdeMs;
    const desdeAnt = new Date(desdeMs - dur).toISOString();
    const hastaAnt = ctx.desde;

    const [k, kAnt, tp, vc, ti] = await Promise.all([
      getKpisPeriodo(ctx.localId, ctx.desde, ctx.hasta),
      getKpisPeriodo(ctx.localId, desdeAnt, hastaAnt),
      getTopProductos(ctx.localId, ctx.desde, ctx.hasta, 1),
      getVentasPorCanal(ctx.localId, ctx.desde, ctx.hasta),
      getTiempos(ctx.localId, ctx.desde, ctx.hasta),
    ]);
    setKpis(k.data);
    setKpisAnterior(kAnt.data);
    setTopProds(tp.data);
    setVentasCanal(vc.data);
    setTiempos(ti.data);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime: ventas cobradas en este local refrescan KPIs/Top/Canales/Tiempos.
  // Debounce alto (3s) para evitar reload por cada inserción durante un rush.
  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    scopeByLocal: true,
    debounceMs: 3000,
    enabled: !!ctx.localId,
  });

  // Registrar export en el ref del layout.
  useEffect(() => {
    ctx.exportRef.current = () => {
      const headers = ['Métrica', 'Valor'];
      const rows: (string | number)[][] = [
        ['Total ventas', kpis?.total_ventas ?? 0],
        ['Cantidad ventas', kpis?.cantidad_ventas ?? 0],
        ['Ticket promedio', kpis?.ticket_promedio ?? 0],
        ['Productos vendidos', kpis?.cantidad_productos ?? 0],
        ['Tiempo cocina prom (seg)', tiempos?.tiempo_promedio_cocina_seg ?? 0],
        ['Tiempo cobro prom (seg)', tiempos?.tiempo_promedio_cobro_seg ?? 0],
      ];
      downloadCSV('dashboard.csv', headers, rows);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, kpis, tiempos]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 w-full" />)}
      </div>
    );
  }

  if (!kpis || kpis.cantidad_ventas === 0) {
    return (
      <div className="rounded-md border border-border p-12 text-center">
        <div className="text-5xl mb-2">📊</div>
        <p className="text-sm font-medium">Sin ventas en el período</p>
        <p className="text-xs text-muted-foreground mt-2">Probá ampliar el rango o esperá a que entren cobros.</p>
      </div>
    );
  }

  const top = topProds[0];
  const mejorCanal = ventasCanal.find(c => c.cantidad_ventas > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Ventas totales"
          valor={formatARS(kpis.total_ventas)}
          sub={`${kpis.cantidad_ventas} ${kpis.cantidad_ventas === 1 ? 'venta' : 'ventas'}`}
          actual={kpis.total_ventas}
          anterior={kpisAnterior?.total_ventas}
          esMonto
        />
        <KpiCard
          label="Ticket promedio"
          valor={formatARS(kpis.ticket_promedio)}
          sub="por venta"
          actual={kpis.ticket_promedio}
          anterior={kpisAnterior?.ticket_promedio}
          esMonto
        />
        <KpiCard
          label="Productos vendidos"
          valor={String(Number(kpis.cantidad_productos))}
          sub="unidades"
          actual={kpis.cantidad_productos}
          anterior={kpisAnterior?.cantidad_productos}
        />
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Tiempo cocina</div>
          <div className="text-2xl font-semibold tabular-nums">{fmtSeg(tiempos?.tiempo_promedio_cocina_seg)}</div>
          <div className="text-[10px] text-muted-foreground">enviado → listo</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {top && (
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Producto del período</div>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-3xl">{top.item_emoji ?? '🍽️'}</span>
              <div>
                <div className="text-sm font-semibold">{top.item_nombre}</div>
                <div className="text-xs text-muted-foreground">{Number(top.cantidad_vendida)} unidades · {formatARS(Number(top.total_facturado))}</div>
              </div>
            </div>
          </Card>
        )}
        {mejorCanal && (
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Mejor canal</div>
            <div className="text-sm font-semibold mt-2">{mejorCanal.canal_nombre}</div>
            <div className="text-xs text-muted-foreground">{formatARS(Number(mejorCanal.total_ventas))} en {mejorCanal.cantidad_ventas} {mejorCanal.cantidad_ventas === 1 ? 'venta' : 'ventas'}</div>
          </Card>
        )}
      </div>

      <BarrasVentasPorCanal canales={ventasCanal} />
    </div>
  );
}

interface KpiCardProps {
  label: string;
  valor: string;
  sub: string;
  actual: number;
  anterior?: number;
  esMonto?: boolean;
}

function KpiCard({ label, valor, sub, actual, anterior }: KpiCardProps) {
  // Sin período anterior con datos: card simple sin chip.
  if (anterior == null || anterior === 0) {
    return (
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{valor}</div>
        <div className="text-[10px] text-muted-foreground">{sub}</div>
      </Card>
    );
  }
  const pct = ((actual - anterior) / anterior) * 100;
  const subio = pct > 1;
  const bajo = pct < -1;
  const igual = !subio && !bajo;
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{valor}</div>
      <div className="flex items-center gap-1 mt-1">
        <div
          className={cn(
            'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium',
            subio && 'bg-success/15 text-success',
            bajo && 'bg-destructive/15 text-destructive',
            igual && 'bg-muted text-muted-foreground',
          )}
        >
          {subio ? <TrendingUp className="h-2.5 w-2.5" /> : bajo ? <TrendingDown className="h-2.5 w-2.5" /> : <Minus className="h-2.5 w-2.5" />}
          {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
        </div>
        <span className="text-[10px] text-muted-foreground">vs anterior</span>
      </div>
    </Card>
  );
}

function BarrasVentasPorCanal({ canales }: { canales: VentasPorCanal[] }) {
  const conVentas = canales.filter(c => Number(c.cantidad_ventas) > 0);
  if (conVentas.length === 0) return null;
  const max = Math.max(...conVentas.map(c => Number(c.total_ventas)));
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground mb-3">Ventas por canal</div>
      <div className="space-y-2">
        {conVentas.map(c => {
          const pct = max > 0 ? (Number(c.total_ventas) / max) * 100 : 0;
          return (
            <div key={c.canal_id}>
              <div className="flex justify-between text-xs">
                <span>{c.canal_nombre}</span>
                <span className="tabular-nums">{formatARS(Number(c.total_ventas))}</span>
              </div>
              <div className="h-2 bg-muted rounded mt-1 overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
