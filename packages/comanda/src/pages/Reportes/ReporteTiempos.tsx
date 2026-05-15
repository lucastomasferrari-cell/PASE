import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getTiempos, downloadCSV, type TiemposReporte } from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';
import { useRealtimeTable } from '@/lib/useRealtimeTable';

function fmtSeg(s: number | null | undefined): string {
  if (s == null) return '—';
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function ReporteTiempos() {
  const ctx = useReportesCtx();
  const [data, setData] = useState<TiemposReporte | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    const { data } = await getTiempos(ctx.localId, ctx.desde, ctx.hasta);
    setData(data);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    scopeByLocal: true,
    debounceMs: 3000,
    enabled: !!ctx.localId,
  });

  useEffect(() => {
    ctx.exportRef.current = () => {
      downloadCSV('reporte-tiempos.csv', ['Métrica', 'Valor'], [
        ['Tiempo cocina prom (seg)', data?.tiempo_promedio_cocina_seg ?? 0],
        ['Tiempo cobro prom (seg)', data?.tiempo_promedio_cobro_seg ?? 0],
        ['Cantidad ventas', data?.cantidad_ventas ?? 0],
      ]);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, data]);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (!data || data.cantidad_ventas === 0) {
    return <div className="rounded-md border border-border p-12 text-center text-sm text-muted-foreground">Sin ventas en el período para calcular tiempos.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Tiempo promedio cocina</div>
        <div className="text-3xl font-semibold tabular-nums mt-2">{fmtSeg(data.tiempo_promedio_cocina_seg)}</div>
        <div className="text-[10px] text-muted-foreground">enviado → listo (KDS)</div>
      </Card>
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Tiempo promedio cobro</div>
        <div className="text-3xl font-semibold tabular-nums mt-2">{fmtSeg(data.tiempo_promedio_cobro_seg)}</div>
        <div className="text-[10px] text-muted-foreground">abierta → cobrada</div>
      </Card>
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Ventas analizadas</div>
        <div className="text-3xl font-semibold tabular-nums mt-2">{data.cantidad_ventas}</div>
        <div className="text-[10px] text-muted-foreground">cobradas en el período</div>
      </Card>
    </div>
  );
}
