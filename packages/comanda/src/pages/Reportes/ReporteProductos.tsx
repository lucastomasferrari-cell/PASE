import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import { getTopProductos, downloadCSV, type TopProducto } from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';

export function ReporteProductos() {
  const ctx = useReportesCtx();
  const [data, setData] = useState<TopProducto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ctx.localId) return;
    let cancelled = false;
    setLoading(true);
    getTopProductos(ctx.localId, ctx.desde, ctx.hasta, 50).then(({ data }) => {
      if (cancelled) return;
      setData(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => {
    ctx.exportRef.current = () => {
      const headers = ['Posición', 'Item', 'Cantidad', 'Total facturado'];
      const rows = data.map((p, i) => [
        i + 1, p.item_nombre,
        Number(p.cantidad_vendida).toFixed(2),
        Number(p.total_facturado).toFixed(2),
      ]);
      downloadCSV('reporte-productos.csv', headers, rows);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, data]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (data.length === 0) {
    return <div className="rounded-md border border-border p-12 text-center text-sm text-muted-foreground">Sin productos vendidos en el período.</div>;
  }
  const totalFacturado = data.reduce((s, p) => s + Number(p.total_facturado), 0);
  const max = Math.max(...data.map(p => Number(p.cantidad_vendida)));

  return (
    <div className="rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 w-12">#</th>
            <th className="text-left px-3 py-2">Producto</th>
            <th className="text-left px-3 py-2 w-1/3">Cantidad</th>
            <th className="text-right px-3 py-2">Total</th>
            <th className="text-right px-3 py-2 w-16">%</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p, i) => {
            const cant = Number(p.cantidad_vendida);
            const tot = Number(p.total_facturado);
            const pct = totalFacturado > 0 ? (tot / totalFacturado) * 100 : 0;
            const wPct = max > 0 ? (cant / max) * 100 : 0;
            return (
              <tr key={p.item_id} className="border-t border-border">
                <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2">{p.item_emoji ?? '🍽️'} {p.item_nombre}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-muted rounded overflow-hidden min-w-[60px]">
                      <div className="h-full bg-primary" style={{ width: `${wPct}%` }} />
                    </div>
                    <span className="tabular-nums text-xs">{cant}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatARS(tot)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
