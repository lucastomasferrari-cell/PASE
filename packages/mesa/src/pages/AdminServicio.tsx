// Servicio — vista compacta de las reservas del día, agrupadas por ZONA y
// ordenadas por hora, con filtro por franja/turno. Pedido de Camilo (ref Woki):
// "ver todo más compacto y a mano las reservas del día". Es de lectura rápida;
// las acciones completas (confirmar, sentar, cancelar, mesa) viven en Reservas.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Users, ChevronDown, ChevronLeft, ChevronRight, MapPin } from 'lucide-react';
import { listReservas, type Reserva, type EstadoReserva } from '@/lib/reservasService';
import { listMesas, type Mesa } from '@/lib/mesasService';

interface Props { localId: number; localNombre: string }

const ESTADO_CFG: Record<EstadoReserva, { label: string; badge: string }> = {
  pendiente:  { label: 'Pendiente',  badge: 'bg-amber-100 text-amber-800 border-amber-200' },
  confirmada: { label: 'Confirmada', badge: 'bg-brand-100 text-brand-800 border-brand-200' },
  sentada:    { label: 'En mesa',    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  finalizada: { label: 'Finalizada', badge: 'bg-slate-100 text-slate-600 border-slate-200' },
  no_show:    { label: 'No vino',    badge: 'bg-red-100 text-red-800 border-red-200' },
  cancelada:  { label: 'Cancelada',  badge: 'bg-slate-100 text-slate-500 border-slate-200 line-through' },
};
// En el servicio del día solo interesan las vivas.
const ESTADOS_VIVOS: EstadoReserva[] = ['pendiente', 'confirmada', 'sentada'];

function horaTxt(iso: string) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}
function isoDelDia(d: Date, finDia = false) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), finDia ? 23 : 0, finDia ? 59 : 0, finDia ? 59 : 0);
  return x.toISOString();
}
function fechaLabel(d: Date) {
  const hoy = new Date();
  const esHoy = d.toDateString() === hoy.toDateString();
  const txt = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return (esHoy ? 'Hoy · ' : '') + txt.charAt(0).toUpperCase() + txt.slice(1);
}

export function AdminServicio({ localId, localNombre }: Props) {
  const [fecha, setFecha] = useState<Date>(new Date());
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [cargando, setCargando] = useState(true);
  const [franja, setFranja] = useState<string | null>(null); // hora "HH:MM" o null = todas
  const [cerradas, setCerradas] = useState<Set<string>>(new Set());

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    void (async () => {
      const [r, m] = await Promise.all([
        listReservas({ localId, desde: isoDelDia(fecha), hasta: isoDelDia(fecha, true), limit: 500 }),
        listMesas(localId),
      ]);
      if (!vivo) return;
      if (r.error) toast.error('No se pudieron cargar las reservas: ' + r.error);
      if (m.error) toast.error('No se pudieron cargar las mesas: ' + m.error);
      setReservas((r.data ?? []).filter((x) => ESTADOS_VIVOS.includes(x.estado)));
      setMesas(m.data ?? []);
      setCargando(false);
    })();
    return () => { vivo = false; };
  }, [localId, fecha]);

  const mesaPorId = useMemo(() => new Map(mesas.map((m) => [m.id, m])), [mesas]);

  function zonaDe(r: Reserva): string {
    const ids = r.mesas_ids?.length ? r.mesas_ids : (r.mesa_id != null ? [r.mesa_id] : []);
    const z = ids.map((id) => mesaPorId.get(id)?.zona).find(Boolean);
    return z ?? 'Sin asignar';
  }
  function mesasTxt(r: Reserva): string | null {
    const ids = r.mesas_ids?.length ? r.mesas_ids : (r.mesa_id != null ? [r.mesa_id] : []);
    const nums = ids.map((id) => mesaPorId.get(id)?.numero).filter((n) => n != null);
    return nums.length ? nums.join(', ') : null;
  }

  // Franjas presentes hoy = horas distintas de las reservas (turnos reales).
  const franjas = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of reservas) {
      const h = horaTxt(r.fecha_hora);
      set.set(h, (set.get(h) ?? 0) + 1);
    }
    return Array.from(set.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [reservas]);

  const visibles = useMemo(
    () => (franja ? reservas.filter((r) => horaTxt(r.fecha_hora) === franja) : reservas),
    [reservas, franja],
  );

  // Agrupar por zona; dentro, ordenar por hora.
  const porZona = useMemo(() => {
    const g = new Map<string, Reserva[]>();
    for (const r of visibles) {
      const z = zonaDe(r);
      if (!g.has(z)) g.set(z, []);
      g.get(z)!.push(r);
    }
    for (const arr of g.values()) arr.sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora));
    // Orden de zonas: primero las con nombre, "Sin asignar" al final.
    return Array.from(g.entries()).sort((a, b) =>
      a[0] === 'Sin asignar' ? 1 : b[0] === 'Sin asignar' ? -1 : a[0].localeCompare(b[0]));
  }, [visibles, mesaPorId]); // eslint-disable-line react-hooks/exhaustive-deps

  const totPersonas = visibles.reduce((s, r) => s + r.personas, 0);

  function toggleZona(z: string) {
    setCerradas((s) => { const n = new Set(s); if (n.has(z)) n.delete(z); else n.add(z); return n; });
  }
  function cambiarDia(delta: number) {
    setFecha((d) => { const n = new Date(d); n.setDate(n.getDate() + delta); return n; });
  }

  return (
    <div className="mt-4 space-y-4 max-w-3xl">
      {/* Cabecera: fecha + totales */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-ink">Servicio · {localNombre}</h2>
          <p className="text-sm text-ink-muted">{fechaLabel(fecha)}</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => cambiarDia(-1)} className="p-2 rounded-lg border border-ink/10 text-ink-soft hover:bg-ink/5" title="Día anterior"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setFecha(new Date())} className="px-3 py-2 rounded-lg border border-ink/10 text-sm text-ink-soft hover:bg-ink/5">Hoy</button>
          <button onClick={() => cambiarDia(1)} className="p-2 rounded-lg border border-ink/10 text-ink-soft hover:bg-ink/5" title="Día siguiente"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {/* Filtro de franjas (turnos del día) */}
      {franjas.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setFranja(null)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border ${franja === null ? 'bg-ink text-white border-ink' : 'border-ink/15 text-ink-soft hover:bg-ink/5'}`}>
            Todas ({reservas.length})
          </button>
          {franjas.map(([h, n]) => (
            <button key={h} onClick={() => setFranja(h)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${franja === h ? 'bg-ink text-white border-ink' : 'border-ink/15 text-ink-soft hover:bg-ink/5'}`}>
              {h} ({n})
            </button>
          ))}
        </div>
      )}

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : visibles.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">No hay reservas {franja ? `a las ${franja}` : 'este día'}</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-ink-muted">
            {visibles.length} reserva{visibles.length === 1 ? '' : 's'} · {totPersonas} comensal{totPersonas === 1 ? '' : 'es'}
          </p>
          {porZona.map(([zona, rs]) => {
            const cerrada = cerradas.has(zona);
            const pers = rs.reduce((s, r) => s + r.personas, 0);
            return (
              <div key={zona} className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
                <button onClick={() => toggleZona(zona)}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-ink/[0.02]">
                  <span className="flex items-center gap-2 font-medium text-ink">
                    <MapPin className="h-4 w-4 text-brand-500" /> {zona}
                  </span>
                  <span className="flex items-center gap-3 text-sm text-ink-muted">
                    <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{pers}</span>
                    <span>{rs.length} res.</span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${cerrada ? '-rotate-90' : ''}`} />
                  </span>
                </button>
                {!cerrada && (
                  <ul className="divide-y divide-ink/5">
                    {rs.map((r) => {
                      const cfg = ESTADO_CFG[r.estado];
                      const mt = mesasTxt(r);
                      return (
                        <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                          <span className="text-sm font-semibold tabular-nums text-ink w-12 shrink-0">{horaTxt(r.fecha_hora)}</span>
                          <span className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-ink truncate block">{r.cliente_nombre}</span>
                            {mt && <span className="text-xs text-ink-muted">Mesa {mt}</span>}
                          </span>
                          <span className="flex items-center gap-1 text-sm text-ink-soft shrink-0">
                            <Users className="h-3.5 w-3.5" />{r.personas}
                          </span>
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${cfg.badge}`}>{cfg.label}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
