// Analytics de reservas — métricas del período seleccionado.
// Carga los datos con listReservas y los agrega en el cliente.
// Sin librería de charts — barras CSS puras.

import { useEffect, useState } from 'react';
import { CalendarCheck, TrendingUp, Users, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listReservas, type Reserva } from '@/services/reservasService';
import { cn } from '@/lib/utils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIAS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function desdeFecha(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ─── Tipos de métricas ────────────────────────────────────────────────────────

interface BarItem { label: string; val: number }

interface Metricas {
  total: number;
  personas: number;
  personasPromedio: number;
  noShows: number;
  tasaNoShow: number;
  canceladas: number;
  confirmadas: number;
  finalizadas: number;
  porDia: BarItem[];       // índice 0-6 (lun=0 en display)
  porFranja: BarItem[];    // franjas de 1h: "12h", "13h", …
  porSemana: BarItem[];    // últimas 5 semanas
}

function agregar(reservas: Reserva[]): Metricas {
  const total      = reservas.length;
  const personas   = reservas.reduce((s, r) => s + r.personas, 0);
  const noShows    = reservas.filter((r) => r.estado === 'no_show').length;
  const canceladas = reservas.filter((r) => r.estado === 'cancelada').length;
  const confirmadas = reservas.filter((r) =>
    r.estado === 'confirmada' || r.estado === 'sentada' || r.estado === 'finalizada' || r.estado === 'pendiente'
  ).length;
  const finalizadas = reservas.filter((r) => r.estado === 'finalizada' || r.estado === 'sentada').length;

  // Por día de semana — mostramos Lun-Vie-Sáb-Dom (reordenado)
  const ORDER_DIA = [1, 2, 3, 4, 5, 6, 0]; // lun…dom
  const countsDia = Array(7).fill(0) as number[];
  for (const r of reservas) {
    const dow = new Date(r.fecha_hora).getDay();
    countsDia[dow] = (countsDia[dow] ?? 0) + 1;
  }
  const porDia: BarItem[] = ORDER_DIA.map((d) => ({
    label: DIAS_ES[d] ?? '',
    val: countsDia[d] ?? 0,
  }));

  // Por franja horaria (cada 2h para no saturar)
  const countsFranja: Record<number, number> = {};
  for (const r of reservas) {
    const h = new Date(r.fecha_hora).getHours();
    const bloque = Math.floor(h / 2) * 2;
    countsFranja[bloque] = (countsFranja[bloque] ?? 0) + 1;
  }
  const horas = Object.keys(countsFranja).map(Number).sort((a, b) => a - b);
  const porFranja: BarItem[] = horas.map((h) => ({
    label: `${h}h`,
    val: countsFranja[h] ?? 0,
  }));

  // Por semana (últimas 5 semanas)
  const ahora = new Date();
  const porSemana: BarItem[] = Array.from({ length: 5 }, (_, i) => {
    const start = new Date(ahora);
    start.setDate(start.getDate() - (4 - i) * 7 - start.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const count = reservas.filter((r) => {
      const d = new Date(r.fecha_hora);
      return d >= start && d < end;
    }).length;
    const label = i === 4 ? 'Esta' : i === 3 ? 'Ant.' : `-${(4 - i) * 7}d`;
    return { label, val: count };
  });

  return {
    total, personas,
    personasPromedio: total > 0 ? Math.round((personas / total) * 10) / 10 : 0,
    noShows, tasaNoShow: total > 0 ? Math.round((noShows / total) * 100) : 0,
    canceladas, confirmadas, finalizadas,
    porDia, porFranja, porSemana,
  };
}

// ─── BarChart simple con CSS ──────────────────────────────────────────────────

function BarChart({
  data, colorClass = 'bg-primary/70', labelBottom = true, altura = 80,
}: {
  data: BarItem[];
  colorClass?: string;
  labelBottom?: boolean;
  altura?: number;
}) {
  const max = Math.max(...data.map((d) => d.val), 1);
  return (
    <div className="flex items-end gap-1.5" style={{ height: altura + 24 }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-col items-center gap-1 flex-1 min-w-0">
          <span className={cn(
            'text-xs text-muted-foreground transition-opacity',
            d.val === 0 && 'opacity-0',
          )}>
            {d.val}
          </span>
          <div
            className={cn('w-full rounded-t transition-all duration-500', colorClass)}
            style={{ height: max > 0 ? `${Math.max((d.val / max) * altura, d.val > 0 ? 4 : 0)}px` : '0px' }}
          />
          {labelBottom && (
            <span className="text-xs text-muted-foreground truncate w-full text-center leading-tight">
              {d.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, colorClass }: {
  label: string; value: string | number; sub?: string; colorClass?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', colorClass)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

type Rango = 7 | 30 | 90;

interface Props {
  localId: number;
}

export function ReservasAnalytics({ localId }: Props) {
  const [rango, setRango] = useState<Rango>(30);
  const [metricas, setMetricas] = useState<Metricas | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void listReservas({
      localId,
      desde: desdeFecha(rango),
      hasta: new Date().toISOString(),
      limit: 2000,
    }).then(({ data }) => {
      setMetricas(agregar(data));
      setLoading(false);
    });
  }, [localId, rango]);

  if (loading) {
    return <p className="py-12 text-center text-muted-foreground text-sm">Calculando…</p>;
  }

  if (!metricas || metricas.total === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <TrendingUp className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">
            Sin datos en los últimos {rango} días.
          </p>
        </CardContent>
      </Card>
    );
  }

  const m = metricas;
  const picoFranja = m.porFranja.reduce((a, b) => (a.val >= b.val ? a : b), { label: '—', val: 0 });
  const picoDia    = m.porDia.reduce((a, b) => (a.val >= b.val ? a : b), { label: '—', val: 0 });

  return (
    <div className="space-y-5">
      {/* Selector de rango */}
      <div className="flex gap-2">
        {([7, 30, 90] as Rango[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRango(r)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-lg border transition-colors',
              rango === r
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-accent',
            )}
          >
            {r === 7 ? 'Última semana' : r === 30 ? 'Últimos 30 días' : 'Últimos 90 días'}
          </button>
        ))}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Total reservas" value={m.total} />
        <KpiCard label="Completadas" value={m.finalizadas}
                 sub={m.total > 0 ? `${Math.round((m.finalizadas / m.total) * 100)}% del total` : undefined}
                 colorClass="text-emerald-600" />
        <KpiCard label="No-shows" value={`${m.tasaNoShow}%`}
                 sub={`${m.noShows} de ${m.total}`}
                 colorClass={m.tasaNoShow > 20 ? 'text-red-600' : m.tasaNoShow > 10 ? 'text-amber-600' : undefined} />
        <KpiCard label="Personas/reserva" value={m.personasPromedio}
                 sub={`${m.personas} personas total`} />
      </div>

      {/* Picos */}
      {(picoFranja.val > 0 || picoDia.val > 0) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border bg-amber-50/50 p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Hora pico</p>
            <p className="text-2xl font-bold mt-1">{picoFranja.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{picoFranja.val} reservas en el período</p>
          </div>
          <div className="rounded-xl border bg-blue-50/50 p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Día más pedido</p>
            <p className="text-2xl font-bold mt-1">{picoDia.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{picoDia.val} reservas en el período</p>
          </div>
        </div>
      )}

      {/* Por día de semana */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
            <CalendarCheck className="h-4 w-4" /> Reservas por día de semana
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={m.porDia} colorClass="bg-primary/60" altura={90} />
        </CardContent>
      </Card>

      {/* Por franja horaria */}
      {m.porFranja.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
              <Users className="h-4 w-4" /> Distribución horaria
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart data={m.porFranja} colorClass="bg-indigo-400/70" altura={80} />
          </CardContent>
        </Card>
      )}

      {/* Tendencia semanal */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" /> Tendencia (últimas 5 semanas)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={m.porSemana} colorClass="bg-emerald-500/60" altura={70} />
        </CardContent>
      </Card>

      {/* Embudo de estados */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" /> Distribución por estado
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { label: 'Confirmadas / Pendientes', val: m.confirmadas, color: 'bg-blue-400' },
              { label: 'Completadas', val: m.finalizadas, color: 'bg-emerald-500' },
              { label: 'Canceladas', val: m.canceladas, color: 'bg-muted-foreground/40' },
              { label: 'No-shows', val: m.noShows, color: 'bg-red-400' },
            ].map(({ label, val, color }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="w-24 text-xs text-muted-foreground shrink-0">{label}</div>
                <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', color)}
                    style={{ width: m.total > 0 ? `${(val / m.total) * 100}%` : '0%' }}
                  />
                </div>
                <div className="text-xs text-muted-foreground w-8 text-right">{val}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
