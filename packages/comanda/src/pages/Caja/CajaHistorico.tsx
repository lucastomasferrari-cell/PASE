import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, History, ClipboardList } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listHistoricoTurnos, type TurnoConCajero } from '@/services/turnosCajaService';
import { formatARS, formatFechaAR, formatHoraAR } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

export function CajaHistorico() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const [turnos, setTurnos] = useState<TurnoConCajero[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listHistoricoTurnos(localId, 100);
    if (err) setError(err);
    setTurnos(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime: cuando otro cajero cierra un turno, aparece en el histórico
  // sin F5.
  useRealtimeTable({ table: 'turnos_caja', onChange: () => reload(), scopeByLocal: true });

  return (
    <div className="container py-6 max-w-5xl">
      <header className="flex items-center gap-3 mb-6 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate('/caja')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Volver
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Histórico de turnos</h1>
        <span className="text-sm text-muted-foreground">{turnos.length} turnos cerrados</span>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={() => navigate('/caja/partes')}>
            <ClipboardList className="h-4 w-4 mr-1" />
            Partes
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : turnos.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <History className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin turnos cerrados</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Cuando cierres un turno, aparecerá acá con el arqueo correspondiente.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[80px_1fr_1fr_1fr_140px_140px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Turno</div>
            <div>Apertura</div>
            <div>Cierre</div>
            <div>Cajero</div>
            <div className="text-right">Diferencia</div>
            <div className="text-right">Inicial → Final</div>
          </div>
          {turnos.map((t, idx) => (
            <div
              key={t.id}
              className={cn(
                'grid grid-cols-[80px_1fr_1fr_1fr_140px_140px] gap-4 px-6 py-3 items-center text-sm',
                idx !== turnos.length - 1 && 'border-b border-border',
              )}
            >
              <div className="font-semibold">#{t.numero}</div>
              <div className="text-muted-foreground">
                <div>{formatFechaAR(t.abierto_at)}</div>
                <div className="text-xs">{formatHoraAR(t.abierto_at)}</div>
              </div>
              <div className="text-muted-foreground">
                {t.cerrado_at ? (
                  <>
                    <div>{formatFechaAR(t.cerrado_at)}</div>
                    <div className="text-xs">{formatHoraAR(t.cerrado_at)}</div>
                  </>
                ) : '—'}
              </div>
              <div className="text-xs text-muted-foreground truncate" title={t.cajero_id}>
                {t.cajero_nombre ?? `${t.cajero_id.slice(0, 8)}…`}
              </div>
              <div className="text-right">
                <DiferenciaBadge diferencia={Number(t.diferencia ?? 0)} />
              </div>
              <div className="text-right text-xs tabular-nums">
                <div>{formatARS(t.monto_inicial)}</div>
                <div className="text-muted-foreground">→ {formatARS(t.monto_final_declarado ?? 0)}</div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function DiferenciaBadge({ diferencia }: { diferencia: number }) {
  if (Math.abs(diferencia) < 0.01) return <Badge variant="green">✓ Coincide</Badge>;
  if (Math.abs(diferencia) < 500) {
    return <Badge variant="amber">{diferencia > 0 ? '+' : ''}{diferencia.toFixed(0)}</Badge>;
  }
  return <Badge variant="red">{diferencia > 0 ? '+' : ''}{diferencia.toFixed(0)}</Badge>;
}
