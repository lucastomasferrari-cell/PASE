import { useCallback, useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle, Award } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/Badge';
import { formatARS } from '@/lib/format';
import { getPerformanceEmpleados, downloadCSV, type PerformanceEmpleado } from '@/services/reportesService';
import { useReportesCtx } from './ReportesLayout';
import { cn } from '@/lib/utils';

// Reporte de performance por cajero: quién vende más, quién anula más,
// quién aplica más descuentos. Pista de anti-fraude (filosofía #6).

export function ReportePerformanceEmpleados() {
  const ctx = useReportesCtx();
  const [data, setData] = useState<PerformanceEmpleado[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    const { data } = await getPerformanceEmpleados(ctx.localId, ctx.desde, ctx.hasta);
    setData(data);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    ctx.exportRef.current = () => {
      downloadCSV('performance-empleados.csv',
        ['Empleado', 'Rol', 'Ventas', 'Total facturado', 'Ticket promedio', 'Propinas', 'Descuentos', 'Anuladas', '# Anuladas'],
        data.map((p) => [
          p.empleado_nombre,
          p.rol_pos ?? '',
          p.cantidad_ventas,
          Number(p.total_facturado).toFixed(2),
          Number(p.ticket_promedio).toFixed(2),
          Number(p.total_propinas).toFixed(2),
          Number(p.total_descuentos).toFixed(2),
          Number(p.total_anuladas).toFixed(2),
          p.cantidad_anuladas,
        ]));
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, data]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (data.length === 0) {
    return (
      <div className="rounded-md border border-border p-12 text-center text-sm text-muted-foreground">
        Sin actividad de empleados en el rango.
      </div>
    );
  }

  // Detectar outliers anti-fraude: empleado con anulaciones >2x el promedio
  const promedioAnuladas = data.reduce((s, p) => s + Number(p.total_anuladas), 0) / Math.max(1, data.length);
  const promedioDescuentos = data.reduce((s, p) => s + Number(p.total_descuentos), 0) / Math.max(1, data.length);

  return (
    <div className="space-y-4">
      {/* Top performer */}
      {data[0] && (
        <Card className="border-amber-300 bg-amber-50/40 dark:bg-amber-950/20">
          <CardContent className="p-4 flex items-center gap-3">
            <Award className="h-8 w-8 text-amber-500" />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">Top vendedor del período</div>
              <div className="text-lg font-bold">{data[0].empleado_nombre}</div>
              <div className="text-sm text-muted-foreground">
                {data[0].cantidad_ventas} ventas · {formatARS(data[0].total_facturado)} facturado · ticket promedio {formatARS(data[0].ticket_promedio)}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Empleado</th>
                <th className="text-right px-4 py-2">Ventas</th>
                <th className="text-right px-4 py-2">Facturado</th>
                <th className="text-right px-4 py-2">Ticket prom.</th>
                <th className="text-right px-4 py-2">Propinas</th>
                <th className="text-right px-4 py-2">Descuentos</th>
                <th className="text-right px-4 py-2">Anuladas</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, idx) => {
                const muchasAnuladas = Number(p.total_anuladas) > promedioAnuladas * 2 && Number(p.total_anuladas) > 1000;
                const muchosDescuentos = Number(p.total_descuentos) > promedioDescuentos * 2 && Number(p.total_descuentos) > 1000;
                return (
                  <tr key={p.empleado_id} className="border-t hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="font-medium flex items-center gap-2">
                        {idx === 0 && <TrendingUp className="h-3.5 w-3.5 text-success" />}
                        {p.empleado_nombre}
                      </div>
                      <Badge variant="gray">{p.rol_pos ?? '—'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{p.cantidad_ventas}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">{formatARS(p.total_facturado)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatARS(p.ticket_promedio)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-success">{formatARS(p.total_propinas)}</td>
                    <td className={cn(
                      'px-4 py-3 text-right tabular-nums',
                      muchosDescuentos ? 'text-warning font-semibold' : 'text-muted-foreground',
                    )}>
                      {muchosDescuentos && <AlertTriangle className="h-3 w-3 inline mr-0.5" />}
                      {formatARS(p.total_descuentos)}
                    </td>
                    <td className={cn(
                      'px-4 py-3 text-right tabular-nums',
                      muchasAnuladas ? 'text-destructive font-semibold' : 'text-muted-foreground',
                    )}>
                      {muchasAnuladas && <AlertTriangle className="h-3 w-3 inline mr-0.5" />}
                      {p.cantidad_anuladas > 0 ? `${p.cantidad_anuladas} · ${formatARS(p.total_anuladas)}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        ⚠ Triángulo amarillo = descuentos &gt;2x el promedio. Triángulo rojo = anulaciones &gt;2x el promedio.
        Patrón de revisión anti-fraude. No es prueba, es señal para auditar.
      </p>
    </div>
  );
}
