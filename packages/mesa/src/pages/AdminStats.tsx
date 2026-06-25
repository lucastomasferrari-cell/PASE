// Informes / Stats de reservas — sección del panel admin de MESA (etapa 4).
// Métricas calculadas en el front desde listReservas (sin RPC): volumen,
// no-shows, cancelaciones, personas promedio, por día y por franja horaria.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { listReservas, type Reserva } from '@/lib/reservasService';

interface Props { localId: number; }

const RANGOS = [
  { dias: 7, label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const FRANJAS = [
  { label: 'Mediodía (12–16)', test: (h: number) => h >= 12 && h < 16 },
  { label: 'Tarde (16–20)', test: (h: number) => h >= 16 && h < 20 },
  { label: 'Noche (20–24)', test: (h: number) => h >= 20 },
  { label: 'Otro', test: (h: number) => h < 12 },
];

function desdeFecha(dias: number) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function AdminStats({ localId }: Props) {
  const [dias, setDias] = useState(30);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async (d: number) => {
    setCargando(true);
    const { data, error } = await listReservas({ localId, desde: desdeFecha(d), limit: 1000 });
    if (error) toast.error('No se pudieron cargar las reservas: ' + error);
    setReservas(data);
    setCargando(false);
  }, [localId]);

  useEffect(() => { void reload(dias); }, [dias, reload]);

  const m = useMemo(() => {
    const total = reservas.length;
    const personas = reservas.reduce((s, r) => s + r.personas, 0);
    const noShows = reservas.filter((r) => r.estado === 'no_show').length;
    const canceladas = reservas.filter((r) => r.estado === 'cancelada').length;
    const finalizadas = reservas.filter((r) => r.estado === 'finalizada' || r.estado === 'sentada').length;
    const porDia = DIAS.map((_, i) => reservas.filter((r) => new Date(r.fecha_hora).getDay() === i).length);
    const porFranja = FRANJAS.map((f) => reservas.filter((r) => f.test(new Date(r.fecha_hora).getHours())).length);
    return {
      total, personas,
      personasProm: total ? (personas / total) : 0,
      noShows, tasaNoShow: total ? Math.round((noShows / total) * 100) : 0,
      canceladas, tasaCancel: total ? Math.round((canceladas / total) * 100) : 0,
      finalizadas,
      porDia, porFranja,
    };
  }, [reservas]);

  return (
    <div className="mt-6 space-y-5 max-w-3xl">
      <div className="flex gap-2">
        {RANGOS.map((r) => (
          <button key={r.dias} onClick={() => setDias(r.dias)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors ${
                    dias === r.dias ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'
                  }`}>
            {r.label}
          </button>
        ))}
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Calculando…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPI label="Reservas" valor={m.total} />
            <KPI label="Personas" valor={m.personas} />
            <KPI label="Personas/reserva" valor={m.personasProm.toFixed(1)} />
            <KPI label="No-shows" valor={`${m.tasaNoShow}%`} tono={m.tasaNoShow > 15 ? 'red' : 'normal'} sub={`${m.noShows} reservas`} />
          </div>

          <Panel titulo="Por día de la semana">
            <Barras datos={m.porDia.map((v, i) => ({ label: DIAS[i]!, valor: v }))} />
          </Panel>

          <Panel titulo="Por franja horaria">
            <Barras datos={m.porFranja.map((v, i) => ({ label: FRANJAS[i]!.label, valor: v }))} horizontal />
          </Panel>

          <div className="text-xs text-ink-muted">
            {m.finalizadas} concretadas · {m.canceladas} canceladas ({m.tasaCancel}%) en los últimos {dias} días.
          </div>
        </>
      )}
    </div>
  );
}

function KPI({ label, valor, sub, tono = 'normal' }: { label: string; valor: string | number; sub?: string; tono?: 'normal' | 'red' }) {
  return (
    <div className="rounded-xl bg-white border border-ink/5 shadow-card p-4">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${tono === 'red' ? 'text-red-600' : 'text-ink'}`}>{valor}</div>
      {sub && <div className="text-[11px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function Panel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
      <p className="text-sm font-medium mb-3">{titulo}</p>
      {children}
    </div>
  );
}

function Barras({ datos, horizontal = false }: { datos: { label: string; valor: number }[]; horizontal?: boolean }) {
  const max = Math.max(1, ...datos.map((d) => d.valor));
  if (horizontal) {
    return (
      <div className="space-y-2">
        {datos.map((d) => (
          <div key={d.label} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 text-ink-soft">{d.label}</span>
            <div className="flex-1 h-4 bg-brand-50 rounded-full overflow-hidden">
              <div className="h-full bg-brand-400 rounded-full transition-all duration-500" style={{ width: `${(d.valor / max) * 100}%` }} />
            </div>
            <span className="w-7 text-right tabular-nums font-medium">{d.valor}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2 h-36">
      {datos.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center gap-1">
          <span className="text-[11px] tabular-nums font-medium text-ink-soft">{d.valor}</span>
          <div className="w-full bg-brand-400 rounded-t transition-all duration-500" style={{ height: `${(d.valor / max) * 100}%`, minHeight: d.valor > 0 ? 3 : 0 }} />
          <span className="text-[11px] text-ink-muted">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
