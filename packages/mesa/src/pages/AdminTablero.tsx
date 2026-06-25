// Tablero / Dashboard — home del panel MESA (estilo Tableo).
// KPIs del día, comensales por turno, resumen del día y de la semana,
// últimas reseñas. Todo computado en el front desde reservas + reviews.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, Users, Clock, Armchair, Star } from 'lucide-react';
import { listReservas, type Reserva } from '@/lib/reservasService';
import { listarReviews, type Review } from '@/lib/reviewsService';

interface Props { localId: number; localSlug: string | null; }

const TURNOS = [
  { label: 'Mediodía', ini: 12 * 60, fin: 16 * 60 },
  { label: 'Tarde', ini: 16 * 60, fin: 20 * 60 },
  { label: 'Primer turno', ini: 20 * 60, fin: 22 * 60 },
  { label: 'Segundo turno', ini: 22 * 60, fin: 24 * 60 + 59 },
];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const ACTIVAS: Reserva['estado'][] = ['pendiente', 'confirmada', 'sentada', 'finalizada'];

function minDia(iso: string) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
function esHoy(iso: string) { const d = new Date(iso); const n = new Date(); return d.toDateString() === n.toDateString(); }
function diaIso(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toDateString(); }

export function AdminTablero({ localId, localSlug }: Props) {
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ratingProm, setRatingProm] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState(0);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const desde = new Date(); desde.setDate(desde.getDate() - 7); desde.setHours(0, 0, 0, 0);
    const [r, rev] = await Promise.all([
      listReservas({ localId, desde: desde.toISOString(), limit: 1000 }),
      localSlug ? listarReviews(localSlug) : Promise.resolve({ data: { reviews: [], rating_promedio: null, total_reviews: 0 }, error: null }),
    ]);
    if (r.error) toast.error('No se pudieron cargar las reservas: ' + r.error);
    setReservas(r.data);
    setReviews(rev.data.reviews.slice(0, 3));
    setRatingProm(rev.data.rating_promedio);
    setTotalReviews(rev.data.total_reviews);
    setCargando(false);
  }, [localId, localSlug]);

  useEffect(() => { void reload(); }, [reload]);

  const hoy = useMemo(() => reservas.filter((r) => esHoy(r.fecha_hora) && ACTIVAS.includes(r.estado)), [reservas]);

  const kpis = useMemo(() => ({
    reservas: hoy.length,
    comensales: hoy.reduce((s, r) => s + r.personas, 0),
    pendientes: hoy.filter((r) => r.estado === 'pendiente').length,
    enMesa: hoy.filter((r) => r.estado === 'sentada').length,
  }), [hoy]);

  const turnos = useMemo(() =>
    TURNOS.map((t) => {
      const rs = hoy.filter((r) => { const m = minDia(r.fecha_hora); return m >= t.ini && m < t.fin; });
      return { ...t, count: rs.length, pax: rs.reduce((s, r) => s + r.personas, 0) };
    }).filter((t) => t.count > 0),
  [hoy]);

  const porHora = useMemo(() => {
    const buckets: Record<number, number> = {};
    for (const r of hoy) { const h = Math.floor(minDia(r.fecha_hora) / 60); buckets[h] = (buckets[h] ?? 0) + r.personas; }
    const horas = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    if (horas.length === 0) return [];
    const min = Math.min(...horas), max = Math.max(...horas);
    const out: { h: number; pax: number }[] = [];
    for (let h = min; h <= max; h++) out.push({ h, pax: buckets[h] ?? 0 });
    return out;
  }, [hoy]);

  const porDia = useMemo(() => {
    const out: { label: string; pax: number; isToday: boolean }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i);
      const key = diaIso(d);
      const pax = reservas.filter((r) => ACTIVAS.includes(r.estado) && diaIso(new Date(r.fecha_hora)) === key)
        .reduce((s, r) => s + r.personas, 0);
      out.push({ label: DIAS[d.getDay()]!, pax, isToday: i === 0 });
    }
    return out;
  }, [reservas]);

  if (cargando) return <div className="py-16 text-center text-ink-muted mt-6">Cargando tablero…</div>;

  return (
    <div className="mt-6 space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI icon={<CalendarCheck className="h-5 w-5" />} label="Reservas hoy" valor={kpis.reservas} />
        <KPI icon={<Users className="h-5 w-5" />} label="Comensales hoy" valor={kpis.comensales} />
        <KPI icon={<Clock className="h-5 w-5" />} label="Por confirmar" valor={kpis.pendientes} tono={kpis.pendientes > 0 ? 'amber' : 'normal'} />
        <KPI icon={<Armchair className="h-5 w-5" />} label="En mesa ahora" valor={kpis.enMesa} tono={kpis.enMesa > 0 ? 'emerald' : 'normal'} />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Comensales por turno */}
        <Card titulo="Comensales por turno (hoy)">
          {turnos.length === 0 ? (
            <p className="text-sm text-ink-muted py-4">Sin reservas para hoy todavía.</p>
          ) : (
            <div className="space-y-2.5">
              {turnos.map((t) => (
                <div key={t.label} className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{t.label}</div>
                    <div className="text-xs text-ink-muted">
                      {String(Math.floor(t.ini / 60)).padStart(2, '0')}:00 – {String(Math.min(23, Math.floor(t.fin / 60))).padStart(2, '0')}:59
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold text-brand-700 inline-flex items-center gap-1"><Users className="h-4 w-4" />{t.pax}</div>
                    <div className="text-xs text-ink-muted">{t.count} reserva{t.count !== 1 ? 's' : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Últimas reseñas */}
        <Card titulo={`Reseñas${ratingProm != null ? ` · ${ratingProm.toFixed(1)}★ (${totalReviews})` : ''}`}>
          {reviews.length === 0 ? (
            <p className="text-sm text-ink-muted py-4">Todavía no hay reseñas.</p>
          ) : (
            <div className="space-y-3">
              {reviews.map((rev) => (
                <div key={rev.review_id} className="border-b border-ink/5 last:border-0 pb-2.5 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{rev.autor_nombre}</span>
                    <Estrellas n={rev.rating} />
                  </div>
                  {rev.comentario && <p className="text-xs text-ink-soft mt-0.5 line-clamp-2">{rev.comentario}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Resumen del día por hora */}
        <Card titulo="Comensales por hora (hoy)">
          {porHora.length === 0 ? (
            <p className="text-sm text-ink-muted py-4">Sin datos para hoy.</p>
          ) : (
            <Barras datos={porHora.map((x) => ({ label: `${x.h}h`, valor: x.pax }))} />
          )}
        </Card>

        {/* Resumen semanal */}
        <Card titulo="Comensales por día (últimos 7)">
          <Barras datos={porDia.map((x) => ({ label: x.label, valor: x.pax, destacar: x.isToday }))} />
        </Card>
      </div>
    </div>
  );
}

function KPI({ icon, label, valor, tono = 'normal' }: { icon: React.ReactNode; label: string; valor: number; tono?: 'normal' | 'amber' | 'emerald' }) {
  const color = tono === 'amber' ? 'text-amber-600' : tono === 'emerald' ? 'text-emerald-600' : 'text-brand-600';
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-50 ${color} mb-2`}>{icon}</div>
      <div className="text-2xl font-semibold text-ink">{valor}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function Card({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
      <p className="text-sm font-medium mb-3">{titulo}</p>
      {children}
    </div>
  );
}

function Estrellas({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-3.5 w-3.5 ${i <= n ? 'text-amber-400 fill-amber-400' : 'text-ink/15'}`} />
      ))}
    </span>
  );
}

function Barras({ datos }: { datos: { label: string; valor: number; destacar?: boolean }[] }) {
  const max = Math.max(1, ...datos.map((d) => d.valor));
  return (
    <div className="flex items-end gap-2 h-36">
      {datos.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <span className="text-[11px] tabular-nums font-medium text-ink-soft">{d.valor}</span>
          <div className={`w-full rounded-t transition-all duration-500 ${d.destacar ? 'bg-brand-600' : 'bg-brand-400'}`}
               style={{ height: `${(d.valor / max) * 100}%`, minHeight: d.valor > 0 ? 3 : 0 }} />
          <span className="text-[11px] text-ink-muted truncate w-full text-center">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
