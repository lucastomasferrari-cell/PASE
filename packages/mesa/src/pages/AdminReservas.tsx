// Reservas — lista filtrable (búsqueda + estado + rango de fechas), agrupada
// por día, con alta/edición y cambios de estado (confirmar, sentar, finalizar,
// no-show, cancelar) + asignación de mesa. La vista timeline de un día está en
// "Diario"; acá es la lista cross-fecha tipo "Reservas" de OpenTable/Tableo.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus, Users, Clock, Pencil, X, Search,
  Check, Armchair, CalendarX, Ban, RotateCcw, MessageCircle,
} from 'lucide-react';
import {
  listReservas, listMesasDelLocal, crearReserva, editarReserva,
  cambiarEstadoReserva, asignarMesaReserva,
  type Reserva, type EstadoReserva, type MesaSimple,
} from '@/lib/reservasService';
import { whatsAppUrl, mensajeConfirmacionReserva } from '@/lib/whatsapp';

interface Props { localId: number; localNombre: string; }

const ESTADO_CFG: Record<EstadoReserva, { label: string; badge: string }> = {
  pendiente:  { label: 'Pendiente',  badge: 'bg-amber-100 text-amber-800 border-amber-200' },
  confirmada: { label: 'Confirmada', badge: 'bg-brand-100 text-brand-800 border-brand-200' },
  sentada:    { label: 'En mesa',    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  finalizada: { label: 'Finalizada', badge: 'bg-slate-100 text-slate-600 border-slate-200' },
  no_show:    { label: 'No vino',    badge: 'bg-red-100 text-red-800 border-red-200' },
  cancelada:  { label: 'Cancelada',  badge: 'bg-slate-100 text-slate-500 border-slate-200 line-through' },
};

function hora(iso: string) { return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); }
function labelFecha(f: Date) {
  const s = f.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// date+time locales → ISO (timestamptz). Inputs dan hora local (Argentina).
function aISO(fecha: string, hora: string) { return new Date(`${fecha}T${hora}`).toISOString(); }
function inputDate(f: Date) { return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`; }

type Rango = 'hoy' | 'semana' | 'proximas' | 'pasadas';
const RANGOS: { key: Rango; label: string }[] = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'semana', label: 'Próx. 7 días' },
  { key: 'proximas', label: 'Próx. 30 días' },
  { key: 'pasadas', label: 'Pasadas' },
];
const ESTADO_FILTROS: { key: EstadoReserva | 'todas'; label: string }[] = [
  { key: 'todas', label: 'Todos los estados' },
  { key: 'pendiente', label: 'Pendientes' },
  { key: 'confirmada', label: 'Confirmadas' },
  { key: 'sentada', label: 'En mesa' },
  { key: 'finalizada', label: 'Finalizadas' },
  { key: 'no_show', label: 'No vino' },
  { key: 'cancelada', label: 'Canceladas' },
];

function rangoFechas(r: Rango): { desde: string; hasta: string } {
  const inicioHoy = new Date(); inicioHoy.setHours(0, 0, 0, 0);
  const finHoy = new Date(); finHoy.setHours(23, 59, 59, 999);
  const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (r === 'hoy') return { desde: inicioHoy.toISOString(), hasta: finHoy.toISOString() };
  if (r === 'semana') return { desde: inicioHoy.toISOString(), hasta: addDays(finHoy, 7).toISOString() };
  if (r === 'proximas') return { desde: inicioHoy.toISOString(), hasta: addDays(finHoy, 30).toISOString() };
  return { desde: addDays(inicioHoy, -60).toISOString(), hasta: finHoy.toISOString() };
}

export function AdminReservas({ localId, localNombre }: Props) {
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [mesas, setMesas] = useState<MesaSimple[]>([]);
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<Reserva | 'nueva' | null>(null);
  const [rango, setRango] = useState<Rango>('semana');
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoReserva | 'todas'>('todas');
  const [search, setSearch] = useState('');

  const reload = useCallback(async () => {
    setCargando(true);
    const { desde, hasta } = rangoFechas(rango);
    const [r, m] = await Promise.all([
      listReservas({ localId, desde, hasta, estado: estadoFiltro, limit: 500 }),
      listMesasDelLocal(localId),
    ]);
    if (r.error) toast.error('No se pudieron cargar las reservas: ' + r.error);
    setReservas(r.data);
    setMesas(m.data);
    setCargando(false);
  }, [localId, rango, estadoFiltro]);

  useEffect(() => { void reload(); }, [reload]);

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rs = reservas;
    if (q) rs = rs.filter((r) => r.cliente_nombre.toLowerCase().includes(q) || (r.cliente_telefono ?? '').includes(q));
    if (rango === 'pasadas') rs = [...rs].sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora));
    return rs;
  }, [reservas, search, rango]);

  // Agrupar por día.
  const porDia = useMemo(() => {
    const map = new Map<string, Reserva[]>();
    for (const r of filtradas) {
      const key = new Date(r.fecha_hora).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries());
  }, [filtradas]);

  const totalPersonas = filtradas.reduce((s, r) => s + r.personas, 0);

  async function accion(p: Promise<{ error: string | null }>, okMsg: string) {
    const { error } = await p;
    if (error) { toast.error(error); return; }
    toast.success(okMsg);
    void reload();
  }

  function nombreMesa(mesaId: number | null) {
    if (mesaId == null) return null;
    const m = mesas.find((x) => x.id === mesaId);
    return m ? `Mesa ${m.numero}` : `Mesa #${mesaId}`;
  }

  return (
    <div className="mt-6">
      {/* Filtros + acción */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre o teléfono…"
                 className="w-full rounded-lg border border-ink/15 bg-white pl-9 pr-3 py-2 text-sm" />
        </div>
        <select value={rango} onChange={(e) => setRango(e.target.value as Rango)}
                className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm">
          {RANGOS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <select value={estadoFiltro} onChange={(e) => setEstadoFiltro(e.target.value as EstadoReserva | 'todas')}
                className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm">
          {ESTADO_FILTROS.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <button onClick={() => setEditando('nueva')}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Nueva
        </button>
      </div>

      <div className="text-sm text-ink-muted mb-3">
        {cargando ? 'Cargando…' : `${filtradas.length} reserva${filtradas.length !== 1 ? 's' : ''} · ${totalPersonas} comensales`}
      </div>

      {/* Lista agrupada por día */}
      {!cargando && filtradas.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">Sin reservas</p>
          <p className="text-sm text-ink-muted mt-1">Probá otro rango o estado, o cargá una con "Nueva".</p>
        </div>
      ) : (
        <div className="space-y-4">
          {porDia.map(([dia, rs]) => (
            <div key={dia}>
              <p className="text-xs uppercase tracking-wide text-ink-muted mb-2">{labelFecha(new Date(dia))}</p>
              <div className="space-y-2">
                {rs.map((r) => (
                  <FilaReserva key={r.id} r={r} mesas={mesas} nombreMesa={nombreMesa} localNombre={localNombre}
                               onEditar={() => setEditando(r)} onAccion={accion} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editando && (
        <FormReserva
          localId={localId}
          localNombre={localNombre}
          fechaDefault={new Date()}
          reserva={editando === 'nueva' ? null : editando}
          onClose={() => setEditando(null)}
          onSaved={() => { setEditando(null); void reload(); }}
        />
      )}
    </div>
  );
}

function FilaReserva({
  r, mesas, nombreMesa, localNombre, onEditar, onAccion,
}: {
  r: Reserva;
  mesas: MesaSimple[];
  nombreMesa: (id: number | null) => string | null;
  localNombre: string;
  onEditar: () => void;
  onAccion: (p: Promise<{ error: string | null }>, okMsg: string) => void;
}) {
  const cfg = ESTADO_CFG[r.estado];
  const editable = r.estado === 'pendiente' || r.estado === 'confirmada';
  const mesaTxt = nombreMesa(r.mesa_id);
  const waUrl = r.cliente_telefono
    ? whatsAppUrl(r.cliente_telefono, mensajeConfirmacionReserva({
        clienteNombre: r.cliente_nombre, localNombre, fechaHora: r.fecha_hora, personas: r.personas,
      }))
    : null;

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 flex items-start gap-4 flex-wrap">
      {/* Hora */}
      <div className="text-center min-w-[54px]">
        <div className="text-lg font-semibold tabular-nums text-ink">{hora(r.fecha_hora)}</div>
        <div className="text-[11px] text-ink-muted inline-flex items-center gap-0.5"><Users className="h-3 w-3" />{r.personas}</div>
      </div>

      {/* Datos */}
      <div className="flex-1 min-w-[160px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{r.cliente_nombre}</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cfg.badge}`}>{cfg.label}</span>
          {mesaTxt && <span className="text-[11px] px-2 py-0.5 rounded-full border border-ink/15 text-ink-soft">{mesaTxt}</span>}
        </div>
        {r.cliente_telefono && <div className="text-xs text-ink-muted mt-0.5">{r.cliente_telefono}</div>}
        {r.notas && <div className="text-xs text-ink-soft mt-1 italic">{r.notas}</div>}
        {r.estado === 'cancelada' && r.motivo_cancelacion && (
          <div className="text-xs text-red-600 mt-1">Motivo: {r.motivo_cancelacion}</div>
        )}
      </div>

      {/* Acciones por estado */}
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        {/* Asignar mesa (no terminal) */}
        {(r.estado === 'pendiente' || r.estado === 'confirmada' || r.estado === 'sentada') && mesas.length > 0 && (
          <select
            value={r.mesa_id ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              onAccion(asignarMesaReserva({ reservaId: r.id, mesaId: Number(v) }), 'Mesa asignada');
            }}
            className="text-xs rounded-lg border border-ink/15 px-2 py-1.5 bg-white max-w-[110px]"
            title="Asignar mesa"
          >
            <option value="">Mesa…</option>
            {mesas.map((m) => (
              <option key={m.id} value={m.id}>Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}</option>
            ))}
          </select>
        )}

        {waUrl && r.estado !== 'cancelada' && r.estado !== 'no_show' && r.estado !== 'finalizada' && (
          <a href={waUrl} target="_blank" rel="noopener noreferrer" title="Escribir por WhatsApp"
             className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-700 font-medium inline-flex items-center gap-1">
            <MessageCircle className="h-3.5 w-3.5" /> WA
          </a>
        )}
        {r.estado === 'pendiente' && (
          <BtnAccion icon={<Check className="h-3.5 w-3.5" />} label="Confirmar" tono="brand"
                     onClick={() => onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'confirmada' }), 'Reserva confirmada')} />
        )}
        {r.estado === 'confirmada' && (
          <BtnAccion icon={<Armchair className="h-3.5 w-3.5" />} label="Sentar" tono="emerald"
                     onClick={() => onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'sentada' }), 'Cliente sentado')} />
        )}
        {r.estado === 'sentada' && (
          <BtnAccion icon={<Check className="h-3.5 w-3.5" />} label="Finalizar" tono="slate"
                     onClick={() => onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'finalizada' }), 'Reserva finalizada')} />
        )}
        {r.estado === 'confirmada' && (
          <BtnAccion icon={<CalendarX className="h-3.5 w-3.5" />} label="No vino" tono="red"
                     onClick={() => onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'no_show' }), 'Marcada como no-show')} />
        )}
        {editable && (
          <>
            <button onClick={onEditar} className="p-1.5 rounded-lg hover:bg-brand-50 text-ink-soft" title="Editar"><Pencil className="h-4 w-4" /></button>
            <BtnAccion icon={<Ban className="h-3.5 w-3.5" />} label="Cancelar" tono="ghost"
                       onClick={() => {
                         const motivo = window.prompt('Motivo de cancelación (opcional):') ?? undefined;
                         onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'cancelada', motivo }), 'Reserva cancelada');
                       }} />
          </>
        )}
        {(r.estado === 'cancelada' || r.estado === 'no_show') && (
          <BtnAccion icon={<RotateCcw className="h-3.5 w-3.5" />} label="Reactivar" tono="ghost"
                     onClick={() => onAccion(cambiarEstadoReserva({ reservaId: r.id, nuevoEstado: 'confirmada' }), 'Reserva reactivada')} />
        )}
      </div>
    </div>
  );
}

function BtnAccion({ icon, label, tono, onClick }: {
  icon: React.ReactNode; label: string; onClick: () => void;
  tono: 'brand' | 'emerald' | 'red' | 'slate' | 'ghost';
}) {
  const cls = {
    brand:   'bg-brand-500 hover:bg-brand-600 text-white border-transparent',
    emerald: 'bg-emerald-500 hover:bg-emerald-600 text-white border-transparent',
    red:     'bg-white hover:bg-red-50 text-red-700 border-red-200',
    slate:   'bg-slate-600 hover:bg-slate-700 text-white border-transparent',
    ghost:   'bg-white hover:bg-ink/5 text-ink-soft border-ink/15',
  }[tono];
  return (
    <button onClick={onClick}
            className={`text-xs px-2.5 py-1.5 rounded-lg border inline-flex items-center gap-1 font-medium ${cls}`}>
      {icon}{label}
    </button>
  );
}

function FormReserva({
  localId, localNombre, fechaDefault, reserva, onClose, onSaved,
}: {
  localId: number;
  localNombre: string;
  fechaDefault: Date;
  reserva: Reserva | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const esEdicion = reserva !== null;
  const fhInicial = reserva ? new Date(reserva.fecha_hora) : null;
  const [nombre, setNombre] = useState(reserva?.cliente_nombre ?? '');
  const [telefono, setTelefono] = useState(reserva?.cliente_telefono ?? '');
  const [personas, setPersonas] = useState(reserva?.personas ?? 2);
  const [fecha, setFecha] = useState(inputDate(fhInicial ?? fechaDefault));
  const [horaStr, setHoraStr] = useState(
    fhInicial ? `${String(fhInicial.getHours()).padStart(2, '0')}:${String(fhInicial.getMinutes()).padStart(2, '0')}` : '21:00',
  );
  const [notas, setNotas] = useState(reserva?.notas ?? '');
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    if (!nombre.trim()) { toast.error('Falta el nombre del cliente'); return; }
    if (personas < 1) { toast.error('Personas debe ser 1 o más'); return; }
    setGuardando(true);
    try {
      const fechaHora = aISO(fecha, horaStr);
      if (esEdicion && reserva) {
        const { error } = await editarReserva({
          reservaId: reserva.id, clienteNombre: nombre.trim(),
          clienteTelefono: telefono.trim() || undefined, fechaHora,
          personas, notas: notas.trim() || undefined,
        });
        if (error) { toast.error(error); return; }
        toast.success('Reserva actualizada');
      } else {
        const { error } = await crearReserva({
          localId, clienteNombre: nombre.trim(),
          clienteTelefono: telefono.trim() || undefined, fechaHora, personas,
          notas: notas.trim() || undefined,
          idempotencyKey: `mesa-admin-${localId}-${nombre.trim()}-${fechaHora}`,
        });
        if (error) { toast.error(error); return; }
        toast.success('Reserva creada');
      }
      onSaved();
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
         onClick={onClose}>
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-xl font-semibold">{esEdicion ? 'Editar reserva' : 'Nueva reserva'}</h3>
            <p className="text-xs text-ink-muted">{localNombre}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Nombre del cliente *</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Juan Pérez" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Teléfono</label>
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="+54 11 …" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Users className="h-3 w-3" />Personas</label>
            <input type="number" min={1} value={personas} onChange={(e) => setPersonas(Math.max(1, Number(e.target.value)))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Fecha</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Clock className="h-3 w-3" />Hora</label>
            <input type="time" value={horaStr} onChange={(e) => setHoraStr(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Notas</label>
          <textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Cumpleaños, mesa junto a la ventana, alergias…" />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void guardar()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear reserva'}
          </button>
        </div>
      </div>
    </div>
  );
}
