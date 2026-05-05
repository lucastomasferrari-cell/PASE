import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import { getVentasPorCanal, downloadCSV, type VentasPorCanal } from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';

export function ReporteCanales() {
  const ctx = useReportesCtx();
  const [data, setData] = useState<VentasPorCanal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ctx.localId) return;
    let cancelled = false;
    setLoading(true);
    getVentasPorCanal(ctx.localId, ctx.desde, ctx.hasta).then(({ data }) => {
      if (cancelled) return;
      setData(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => {
    ctx.exportRef.current = () => {
      const headers = ['Canal', 'Ventas', 'Total', 'Ticket prom', 'Comisión %', 'Comisión total', 'Margen neto'];
      const rows = data.map(c => [
        c.canal_nombre,
        c.cantidad_ventas,
        Number(c.total_ventas).toFixed(2),
        Number(c.ticket_promedio).toFixed(2),
        Number(c.comision_pct).toFixed(2),
        Number(c.comision_total).toFixed(2),
        Number(c.margen_neto).toFixed(2),
      ]);
      downloadCSV('reporte-canales.csv', headers, rows);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, data]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  const conVentas = data.filter(d => Number(d.cantidad_ventas) > 0);
  if (conVentas.length === 0) {
    return (
      <div className="rounded-md border border-border p-12 text-center text-sm text-muted-foreground">
        Sin ventas en el período.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">Canal</th>
            <th className="text-right px-3 py-2">Ventas</th>
            <th className="text-right px-3 py-2">Total</th>
            <th className="text-right px-3 py-2">Ticket prom</th>
            <th className="text-right px-3 py-2">Comis. %</th>
            <th className="text-right px-3 py-2">Comis. $</th>
            <th className="text-right px-3 py-2">Margen neto</th>
          </tr>
        </thead>
        <tbody>
          {data.map(c => (
            <tr key={c.canal_id} className="border-t border-border">
              <td className="px-3 py-2">
                <span className="inline-block h-2 w-2 rounded-full mr-2" style={{ background: c.canal_color ?? '#888' }} />
                {c.canal_nombre}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{c.cantidad_ventas}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatARS(Number(c.total_ventas))}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatARS(Number(c.ticket_promedio))}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(c.comision_pct).toFixed(1)}%</td>
              <td className="px-3 py-2 text-right tabular-nums text-destructive">{formatARS(Number(c.comision_total))}</td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">{formatARS(Number(c.margen_neto))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
