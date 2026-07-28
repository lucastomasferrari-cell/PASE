// Reporte "Reservas por fuente" — de dónde llegan las reservas (pauta / IG
// orgánico / Google / directo, etc.), a partir de la atribución guardada en
// cada reserva (UTM + click-ids + referrer). Ver migración 202607281200.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadCSV } from '@/services/reportesService';
import { getReservasAtribucion, clasificarFuenteReserva } from '@/services/reservasService';
import { useReportesCtx } from './ReportesLayout';
import { useRealtimeTable } from '@/lib/useRealtimeTable';

interface Fila { fuente: string; reservas: number; pct: number }

export function ReporteReservasFuente() {
  const ctx = useReportesCtx();
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    const hasta = ctx.hasta.length === 10 ? `${ctx.hasta}T23:59:59.999` : ctx.hasta;
    const { data } = await getReservasAtribucion(ctx.localId, ctx.desde, hasta);
    const conteo = new Map<string, number>();
    for (const r of data) {
      const f = clasificarFuenteReserva(r);
      conteo.set(f, (conteo.get(f) ?? 0) + 1);
    }
    const n = data.length;
    const rows: Fila[] = Array.from(conteo.entries())
      .map(([fuente, reservas]) => ({ fuente, reservas, pct: n > 0 ? (reservas / n) * 100 : 0 }))
      .sort((a, b) => b.reservas - a.reservas);
    setFilas(rows);
    setTotal(n);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta]);

  useEffect(() => { void reload(); }, [reload]);

  useRealtimeTable({
    table: 'reservas',
    onChange: () => void reload(),
    scopeByLocal: true,
    debounceMs: 3000,
    enabled: !!ctx.localId,
  });

  useEffect(() => {
    ctx.exportRef.current = () => {
      const headers = ['Fuente', 'Reservas', '%'];
      const rows = filas.map((f) => [f.fuente, String(f.reservas), f.pct.toFixed(1)]);
      downloadCSV('reservas-por-fuente.csv', headers, rows);
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx, filas]);

  const maxReservas = useMemo(() => Math.max(1, ...filas.map((f) => f.reservas)), [filas]);

  if (loading) {
    return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  }

  if (total === 0) {
    return (
      <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
        Todavía no hay reservas con fuente en este período.
        <p className="mt-1 text-xs">Las reservas que entren desde la web pública van a mostrar de dónde vienen (pauta, Instagram, Google, directo…).</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{total}</span> reservas en el período, por fuente de origen.
      </p>
      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Fuente</th>
              <th className="text-right px-3 py-2">Reservas</th>
              <th className="text-right px-3 py-2">%</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.fuente} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{f.fuente}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(f.reservas / maxReservas) * 100}%` }} />
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium align-top">{f.reservas}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground align-top">{f.pct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
