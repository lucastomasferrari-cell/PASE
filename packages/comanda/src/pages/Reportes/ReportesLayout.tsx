import { useMemo, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Button } from '@/components/ui/button';
import { getRangoPeriodo, type PeriodoReporte } from '@/services/reportesService';

export interface ReportesCtx {
  localId: number | null;
  desde: string;
  hasta: string;
  exportRef: { current: (() => void) | null };
}

export function ReportesLayout() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [periodo, setPeriodo] = useState<PeriodoReporte>('hoy');
  const [customDesde, setCustomDesde] = useState('');
  const [customHasta, setCustomHasta] = useState('');
  const exportRef = useMemo<{ current: (() => void) | null }>(() => ({ current: null }), []);

  const { desde, hasta } = getRangoPeriodo(periodo, customDesde, customHasta);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Reportes</h1>
          <p className="text-xs text-muted-foreground">Datos del local activo · ventas cobradas</p>
        </div>
        <Button
          variant="outline"
          onClick={() => exportRef.current?.()}
          className="gap-2"
        >
          <Download className="h-4 w-4" /> Exportar CSV
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm">
        {(['hoy', 'ayer', 'semana', 'mes', 'custom'] as PeriodoReporte[]).map(p => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriodo(p)}
            className={`px-3 h-9 rounded-full border ${periodo === p ? 'bg-primary text-primary-foreground border-primary' : 'border-border'}`}
          >
            {p === 'hoy' ? 'Hoy' : p === 'ayer' ? 'Ayer' : p === 'semana' ? 'Última semana' : p === 'mes' ? 'Último mes' : 'Custom'}
          </button>
        ))}
        {periodo === 'custom' && (
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={customDesde}
              onChange={e => setCustomDesde(e.target.value)}
              className="h-9 px-2 rounded border border-border bg-background text-sm"
              aria-label="Fecha desde"
            />
            <span className="text-xs" aria-hidden>→</span>
            <input
              type="date"
              value={customHasta}
              onChange={e => setCustomHasta(e.target.value)}
              className="h-9 px-2 rounded border border-border bg-background text-sm"
              aria-label="Fecha hasta"
            />
          </div>
        )}
      </div>

      {/* Inner nav removida en sprint 6: el sidebar admin maneja la
          navegación entre dashboard / canales / productos / tiempos. */}

      {!localId ? (
        <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
          Seleccioná un local en el sidebar para ver reportes.
        </div>
      ) : (
        <Outlet context={{ localId, desde, hasta, exportRef } satisfies ReportesCtx} />
      )}
    </div>
  );
}

export function useReportesCtx(): ReportesCtx {
  return useOutletContext<ReportesCtx>();
}
