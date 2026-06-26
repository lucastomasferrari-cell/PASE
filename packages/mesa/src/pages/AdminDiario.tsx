// Diario / Timeline del servicio — vista estrella estilo OpenTable / Tableo.
// Mesas (filas, agrupadas por zona) × horas (columnas). Cada reserva es un
// bloque posicionado por hora de inicio + duración, coloreado por estado.
// Click en un bloque → acciones rápidas (confirmar/sentar/finalizar/cancelar + WA).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Users, X, Check, Armchair, Ban, MessageCircle, CalendarX, UserPlus, Pencil } from 'lucide-react';
import {
  listReservas, listMesasDelLocal, cambiarEstadoReserva, sentarDePaso,
  type Reserva, type EstadoReserva, type MesaSimple,
} from '@/lib/reservasService';
import { whatsAppUrl, mensajeConfirmacionReserva } from '@/lib/whatsapp';
import { calcularRango, bloqueTimeline } from '@/lib/reservasUtils';
import { WalkInDialog } from '@/components/WalkInDialog';
import { ReservaForm } from '@/components/ReservaForm';

interface Props { localId: number; localNombre: string; }

const PX_PER_MIN = 1.7;                  // ancho de la grilla
const ROW_H = 46;                        // alto de cada fila de mesa
const DUR_DEFAULT = 90;                  // duración si la reserva no la trae

const ESTADO_COLOR: Record<EstadoReserva, { bg: string; text: string; bar: string }> = {
  pendiente:  { bg: 'bg-amber-100',   text: 'text-amber-900',   bar: 'border-l-amber-400' },
  confirmada: { bg: 'bg-emerald-100', text: 'text-emerald-900', bar: 'border-l-emerald-500' },
  sentada:    { bg: 'bg-brand-200',   text: 'text-brand-900',   bar: 'border-l-brand-500' },
  finalizada: { bg: 'bg-slate-100',   text: 'text-slate-600',   bar: 'border-l-slate-300' },
  no_show:    { bg: 'bg-red-100',     text: 'text-red-800',     bar: 'border-l-red-400' },
  cancelada:  { bg: 'bg-slate-100',   text: 'text-slate-400',   bar: 'border-l-slate-300' },
};
const ESTADO_LABEL: Record<EstadoReserva, string> = {
  pendiente: 'Pendiente', confirmada: 'Confirmada', sentada: 'En mesa',
  finalizada: 'Finalizada', no_show: 'No vino', cancelada: 'Cancelada',
};

function startOfDay(f: Date) { return new Date(f.getFullYear(), f.getMonth(), f.getDate(), 0, 0, 0, 0).toISOString(); }
function endOfDay(f: Date) { return new Date(f.getFullYear(), f.getMonth(), f.getDate(), 23, 59, 59, 999).toISOString(); }
function minutosDelDia(iso: string) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
function hhmm(iso: string) { return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); }
function mismoDia(a: Date, b: Date) { return a.toDateString() === b.toDateString(); }
function labelFecha(f: Date) {
  const s = f.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function AdminDiario({ localId, localNombre }: Props) {
  const [fecha, setFecha] = useState(() => new Date());
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [mesas, setMesas] = useState<MesaSimple[]>([]);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState<Reserva | null>(null);
  const [dePaso, setDePaso] = useState(false);
  const [editando, setEditando] = useState<Reserva | null>(null);

  const reload = useCallback(async () => {
    setCargando(true);
    const [r, m] = await Promise.all([
      listReservas({ localId, desde: startOfDay(fecha), hasta: endOfDay(fecha) }),
      listMesasDelLocal(localId),
    ]);
    if (r.error) toast.error('No se pudieron cargar las reservas: ' + r.error);
    setReservas(r.data.filter((x) => x.estado !== 'cancelada'));
    setMesas(m.data);
    setCargando(false);
    setSel(null);
  }, [localId, fecha]);

  useEffect(() => { void reload(); }, [reload]);

  // Rango horario: arranca a las 12 (o antes si hay reservas temprano) hasta
  // las 24 (o más si alguna termina más tarde).
  const { rangoIni, rangoFin, horas } = useMemo(
    () => calcularRango(reservas.map((r) => ({ startMin: minutosDelDia(r.fecha_hora), durMin: r.duracion_min ?? DUR_DEFAULT }))),
    [reservas],
  );

  const anchoGrid = (rangoFin - rangoIni) * PX_PER_MIN;

  // Mesas agrupadas por zona, en orden.
  const zonas = useMemo(() => {
    const map = new Map<string, MesaSimple[]>();
    for (const m of mesas) {
      const z = m.zona ?? 'Sin zona';
      if (!map.has(z)) map.set(z, []);
      map.get(z)!.push(m);
    }
    return Array.from(map.entries());
  }, [mesas]);

  const reservasPorMesa = useMemo(() => {
    const map = new Map<number, Reserva[]>();
    const sinMesa: Reserva[] = [];
    for (const r of reservas) {
      if (r.mesa_id == null) sinMesa.push(r);
      else { if (!map.has(r.mesa_id)) map.set(r.mesa_id, []); map.get(r.mesa_id)!.push(r); }
    }
    return { map, sinMesa };
  }, [reservas]);

  const hoy = useMemo(() => new Date(), []);
  const nowLeft = mismoDia(fecha, hoy)
    ? (hoy.getHours() * 60 + hoy.getMinutes() - rangoIni) * PX_PER_MIN
    : null;

  async function accionRapida(r: Reserva, nuevoEstado: 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada') {
    const { error } = await cambiarEstadoReserva({ reservaId: r.id, nuevoEstado });
    if (error) { toast.error(error); return; }
    toast.success(`${r.cliente_nombre} → ${ESTADO_LABEL[nuevoEstado]}`);
    void reload();
  }

  const totalCovers = reservas.reduce((s, r) => s + r.personas, 0);

  return (
    <div className="mt-6">
      {/* Barra de fecha */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="flex items-center rounded-xl border border-ink/15 bg-white overflow-hidden">
          <button onClick={() => setFecha((f) => { const n = new Date(f); n.setDate(n.getDate() - 1); return n; })}
                  className="px-2.5 py-2 hover:bg-brand-50 text-ink-soft"><ChevronLeft className="h-4 w-4" /></button>
          <div className="px-4 py-2 text-sm font-medium min-w-[190px] text-center">{labelFecha(fecha)}</div>
          <button onClick={() => setFecha((f) => { const n = new Date(f); n.setDate(n.getDate() + 1); return n; })}
                  className="px-2.5 py-2 hover:bg-brand-50 text-ink-soft"><ChevronRight className="h-4 w-4" /></button>
        </div>
        {!mismoDia(fecha, hoy) && (
          <button onClick={() => setFecha(new Date())} className="text-sm text-brand-600 hover:underline">Hoy</button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-ink-muted">{reservas.length} reservas · {totalCovers} comensales</span>
          <button onClick={() => setDePaso(true)}
                  className="rounded-lg border border-brand-300 bg-white hover:bg-brand-50 text-brand-700 px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
            <UserPlus className="h-4 w-4" /> De paso
          </button>
        </div>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando timeline…</div>
      ) : mesas.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">Este local no tiene mesas cargadas</p>
          <p className="text-sm text-ink-muted mt-1">Cargá las mesas desde COMANDA → Configuración → Mesas para ver el diario.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-ink/10 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <div style={{ minWidth: 150 + anchoGrid }}>
              {/* Header de horas */}
              <div className="flex sticky top-0 z-10 bg-white border-b border-ink/10">
                <div className="w-[150px] shrink-0 border-r border-ink/10" />
                <div className="relative" style={{ width: anchoGrid, height: 32 }}>
                  {horas.map((h) => (
                    <div key={h} className="absolute top-0 h-full flex items-center"
                         style={{ left: (h - rangoIni) * PX_PER_MIN }}>
                      <span className="text-[11px] text-ink-muted font-medium -translate-x-1/2 px-1">
                        {String(Math.floor((h % (24 * 60)) / 60)).padStart(2, '0')}:00
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sin mesa */}
              {reservasPorMesa.sinMesa.length > 0 && (
                <FilaTimeline label="Sin asignar" sublabel={`${reservasPorMesa.sinMesa.length}`} destacado
                  reservas={reservasPorMesa.sinMesa} rangoIni={rangoIni} anchoGrid={anchoGrid} nowLeft={nowLeft}
                  onSel={setSel} horas={horas} />
              )}

              {/* Zonas + mesas */}
              {zonas.map(([zona, ms]) => (
                <div key={zona}>
                  <div className="flex bg-brand-50/50 border-y border-ink/5">
                    <div className="w-[150px] shrink-0 px-3 py-1.5 text-[11px] uppercase tracking-wide font-medium text-ink-soft">{zona}</div>
                    <div style={{ width: anchoGrid }} />
                  </div>
                  {ms.map((m) => (
                    <FilaTimeline key={m.id} label={`Mesa ${m.numero}`} sublabel={m.capacidad ? `${m.capacidad}p` : undefined}
                      reservas={reservasPorMesa.map.get(m.id) ?? []} rangoIni={rangoIni} anchoGrid={anchoGrid}
                      nowLeft={nowLeft} onSel={setSel} horas={horas} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Popover de detalle / acciones */}
      {sel && (
        <DetalleReserva r={sel} localNombre={localNombre} onClose={() => setSel(null)} onAccion={accionRapida}
                        onEditar={() => { setEditando(sel); setSel(null); }} />
      )}

      {/* Editar reserva */}
      {editando && (
        <ReservaForm
          localId={localId} localNombre={localNombre} fechaDefault={fecha} reserva={editando}
          onClose={() => setEditando(null)}
          onSaved={() => { setEditando(null); void reload(); }}
        />
      )}

      {/* De paso (walk-in) */}
      {dePaso && (
        <WalkInDialog
          mesas={mesas}
          onClose={() => setDePaso(false)}
          onSave={async (input) => {
            const { error } = await sentarDePaso({ localId, ...input });
            if (error) { toast.error(error); return; }
            toast.success('Walk-in sentado');
            setDePaso(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}


function FilaTimeline({
  label, sublabel, reservas, rangoIni, anchoGrid, nowLeft, onSel, horas, destacado,
}: {
  label: string; sublabel?: string; reservas: Reserva[]; rangoIni: number; anchoGrid: number;
  nowLeft: number | null; onSel: (r: Reserva) => void; horas: number[]; destacado?: boolean;
}) {
  return (
    <div className="flex border-b border-ink/5">
      <div className={`w-[150px] shrink-0 border-r border-ink/10 px-3 flex flex-col justify-center ${destacado ? 'bg-amber-50' : ''}`}
           style={{ height: ROW_H }}>
        <span className="text-sm font-medium text-ink leading-tight">{label}</span>
        {sublabel && <span className="text-[11px] text-ink-muted">{sublabel}</span>}
      </div>
      <div className="relative" style={{ width: anchoGrid, height: ROW_H }}>
        {/* líneas de hora */}
        {horas.map((h) => (
          <div key={h} className="absolute top-0 bottom-0 border-l border-ink/5" style={{ left: (h - rangoIni) * PX_PER_MIN }} />
        ))}
        {/* línea de ahora */}
        {nowLeft != null && nowLeft >= 0 && nowLeft <= anchoGrid && (
          <div className="absolute top-0 bottom-0 w-px bg-red-400/70 z-10" style={{ left: nowLeft }} />
        )}
        {/* reservas */}
        {reservas.map((r) => {
          const s = minutosDelDia(r.fecha_hora);
          const dur = r.duracion_min ?? DUR_DEFAULT;
          const { left, width } = bloqueTimeline(s, dur, rangoIni, PX_PER_MIN);
          const c = ESTADO_COLOR[r.estado];
          return (
            <button key={r.id} onClick={() => onSel(r)} title={`${r.cliente_nombre} · ${hhmm(r.fecha_hora)} · ${r.personas}p`}
                    className={`absolute top-1 bottom-1 rounded-md border-l-4 ${c.bg} ${c.text} ${c.bar} px-2 text-left overflow-hidden hover:ring-2 hover:ring-brand-300 transition-shadow`}
                    style={{ left, width }}>
              <div className="text-[11px] font-semibold leading-tight truncate">{r.cliente_nombre}</div>
              <div className="text-[10px] leading-tight opacity-80 flex items-center gap-1">
                <Users className="h-2.5 w-2.5" />{r.personas} · {hhmm(r.fecha_hora)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DetalleReserva({
  r, localNombre, onClose, onAccion, onEditar,
}: {
  r: Reserva; localNombre: string; onClose: () => void;
  onAccion: (r: Reserva, e: 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada') => void;
  onEditar: () => void;
}) {
  const waUrl = r.cliente_telefono
    ? whatsAppUrl(r.cliente_telefono, mensajeConfirmacionReserva({ clienteNombre: r.cliente_nombre, localNombre, fechaHora: r.fecha_hora, personas: r.personas }))
    : null;
  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display text-xl font-semibold">{r.cliente_nombre}</h3>
            <p className="text-sm text-ink-muted">{hhmm(r.fecha_hora)} · {r.personas} personas · {ESTADO_LABEL[r.estado]}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        {r.cliente_telefono && <p className="text-sm text-ink-soft">{r.cliente_telefono}</p>}
        {r.notas && <p className="text-sm bg-muted/50 rounded p-2 text-ink-soft italic">{r.notas}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {r.estado === 'pendiente' && (
            <BtnQ tono="brand" icon={<Check className="h-4 w-4" />} label="Confirmar" onClick={() => {
              // Abrimos WhatsApp en el mismo click (después no se puede sin trigger directo)
              if (waUrl) { window.open(waUrl, '_blank', 'noopener,noreferrer'); }
              onAccion(r, 'confirmada');
            }} />
          )}
          {(r.estado === 'pendiente' || r.estado === 'confirmada') && (
            <BtnQ tono="emerald" icon={<Armchair className="h-4 w-4" />} label="Sentar" onClick={() => onAccion(r, 'sentada')} />
          )}
          {r.estado === 'sentada' && (
            <BtnQ tono="slate" icon={<Check className="h-4 w-4" />} label="Finalizar" onClick={() => onAccion(r, 'finalizada')} />
          )}
          {r.estado === 'confirmada' && (
            <BtnQ tono="ghost" icon={<CalendarX className="h-4 w-4" />} label="No vino" onClick={() => onAccion(r, 'no_show')} />
          )}
          {(r.estado === 'pendiente' || r.estado === 'confirmada') && (
            <BtnQ tono="ghost" icon={<Pencil className="h-4 w-4" />} label="Editar" onClick={onEditar} />
          )}
          {(r.estado === 'pendiente' || r.estado === 'confirmada') && (
            <BtnQ tono="ghost" icon={<Ban className="h-4 w-4" />} label="Cancelar" onClick={() => onAccion(r, 'cancelada')} />
          )}
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer"
               className="text-sm px-3 py-2 rounded-lg border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-700 font-medium inline-flex items-center gap-1.5">
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function BtnQ({ tono, icon, label, onClick }: {
  tono: 'brand' | 'emerald' | 'slate' | 'ghost'; icon: React.ReactNode; label: string; onClick: () => void;
}) {
  const cls = {
    brand: 'bg-brand-500 hover:bg-brand-600 text-white border-transparent',
    emerald: 'bg-emerald-500 hover:bg-emerald-600 text-white border-transparent',
    slate: 'bg-slate-600 hover:bg-slate-700 text-white border-transparent',
    ghost: 'bg-white hover:bg-ink/5 text-ink-soft border-ink/15',
  }[tono];
  return (
    <button onClick={onClick} className={`text-sm px-3 py-2 rounded-lg border inline-flex items-center gap-1.5 font-medium ${cls}`}>
      {icon}{label}
    </button>
  );
}
