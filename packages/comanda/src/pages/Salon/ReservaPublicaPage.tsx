// Página pública de reservas — /reservar/:slug
//
// Link directo que el local comparte (QR, IG, etc). No requiere auth.
// El cliente elige fecha → slot de horario → personas → datos → reserva.
// Usa dbAnon (sin sesión Supabase).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CalendarCheck, Users, Clock, AlertCircle, Check, ChevronLeft, ChevronRight, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  getReservasInfoPublico,
  checkDisponibilidadReserva,
  crearReservaPublica,
  cancelarReservaPublica,
  type ReservasInfoPublico,
} from '@/services/reservasService';
import { cn } from '@/lib/utils';

// ─── Helpers de fecha ─────────────────────────────────────────────────────────

function hoy(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DIAS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

function fmtFechaLarga(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()]}`;
}

function fmtFechaHora(fechaIso: string, hora: string): string {
  const d = new Date(fechaIso + 'T00:00:00');
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()]} a las ${hora}`;
}

// Genera slots cada 30 min desde abre hasta (cierre - durMinutos)
function generarSlots(abre: string, cierra: string, durMinutos: number): string[] {
  const [ah, am] = abre.split(':').map(Number);
  const [ch, cm] = cierra.split(':').map(Number);
  const inicioMin = (ah ?? 0) * 60 + (am ?? 0);
  const finMin    = (ch ?? 0) * 60 + (cm ?? 0) - durMinutos;
  const slots: string[] = [];
  for (let m = inicioMin; m <= finMin; m += 30) {
    slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return slots;
}

// ─── Mini calendario de mes ───────────────────────────────────────────────────

interface CalProps {
  selected: string | null;
  min: Date;
  max: Date;
  diasHabilitados: number[]; // 0=dom…6=sab
  onSelect: (iso: string) => void;
}

function MiniCalendario({ selected, min, max, diasHabilitados, onSelect }: CalProps) {
  const [mesBase, setMesBase] = useState<Date>(() => {
    const d = new Date(min);
    d.setDate(1);
    return d;
  });

  const primerDia = new Date(mesBase.getFullYear(), mesBase.getMonth(), 1);
  const ultimoDia = new Date(mesBase.getFullYear(), mesBase.getMonth() + 1, 0);
  const offsetInicio = primerDia.getDay();
  const diasEnMes = ultimoDia.getDate();

  const cells: Array<Date | null> = [
    ...Array.from({ length: offsetInicio }, () => null),
    ...Array.from({ length: diasEnMes }, (_, i) => {
      const d = new Date(mesBase.getFullYear(), mesBase.getMonth(), i + 1);
      return d;
    }),
  ];

  const canPrev = primerDia > min;
  const canNext = (() => {
    const nextMes = new Date(mesBase.getFullYear(), mesBase.getMonth() + 1, 1);
    return nextMes <= max;
  })();

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      {/* Navegación */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setMesBase((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          disabled={!canPrev}
          className="p-1.5 rounded hover:bg-accent disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">
          {MESES_ES[mesBase.getMonth()]} {mesBase.getFullYear()}
        </span>
        <button
          type="button"
          onClick={() => setMesBase((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          disabled={!canNext}
          className="p-1.5 rounded hover:bg-accent disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Cabecera días */}
      <div className="grid grid-cols-7 mb-1">
        {DIAS_ES.map((d) => (
          <div key={d} className="text-center text-xs text-muted-foreground font-medium py-1">{d}</div>
        ))}
      </div>

      {/* Grilla de días */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, idx) => {
          if (!d) return <div key={idx} />;
          const iso = isoDate(d);
          const habilitado = diasHabilitados.includes(d.getDay()) && d >= min && d <= max;
          const esHoy = iso === isoDate(hoy());
          const seleccionado = iso === selected;
          return (
            <button
              key={iso}
              type="button"
              disabled={!habilitado}
              onClick={() => onSelect(iso)}
              className={cn(
                'h-8 w-full rounded-lg text-sm font-medium transition-colors',
                !habilitado && 'text-muted-foreground/30 cursor-default',
                habilitado && !seleccionado && 'hover:bg-accent text-foreground',
                esHoy && !seleccionado && 'ring-1 ring-primary/50 text-primary',
                seleccionado && 'bg-primary text-primary-foreground',
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

type Paso = 'fecha' | 'hora' | 'datos' | 'ok' | 'cancelar';

const ERRORES: Record<string, string> = {
  LOCAL_NO_ENCONTRADO: 'Este local no existe',
  RESERVAS_DESACTIVADAS: 'Este local no toma reservas online por ahora',
  PERSONAS_INVALIDAS: 'Cantidad de personas inválida',
  ANTICIPACION_INSUFICIENTE: 'Necesitamos más anticipación para la reserva',
  FECHA_DEMASIADO_LEJANA: 'Esa fecha está muy lejos — elegí una más cercana',
  SIN_CUPO: '😔 No queda lugar para ese horario. Probá otro.',
  TELEFONO_REQUERIDO: 'El teléfono es obligatorio',
  NOMBRE_REQUERIDO: 'Tu nombre es obligatorio',
};

// Layout común de la página (cabecera + container). A nivel de módulo (no
// dentro del render) para no recrear el componente en cada render — recibe
// `info` por prop ya que es lo único del scope que necesita.
function Shell({ info, children }: { info: ReservasInfoPublico; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center py-8 px-4">
      <div className="w-full max-w-sm space-y-5">
        {/* Cabecera */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{info.local_nombre}</h1>
          <p className="text-sm text-muted-foreground flex items-center justify-center gap-1.5">
            <CalendarCheck className="h-4 w-4" /> Reservas online
          </p>
        </div>

        {info.notas_publicas && (
          <div className="text-xs text-foreground/70 bg-amber-50 border border-amber-200 rounded-lg p-3">
            {info.notas_publicas}
          </div>
        )}

        {children}

        <p className="text-center text-xs text-muted-foreground/50 pt-2">
          Powered by COMANDA
        </p>
      </div>
    </div>
  );
}

export function ReservaPublicaPage() {
  const { slug } = useParams<{ slug: string }>();
  const [info, setInfo] = useState<ReservasInfoPublico | null>(null);
  const [cargando, setCargando] = useState(true);

  // Paso wizard
  const [paso, setPaso] = useState<Paso>('fecha');

  // Step 1: fecha + hora
  const [fecha, setFecha]     = useState<string | null>(null);
  const [hora, setHora]       = useState<string | null>(null);
  const [personas, setPersonas] = useState(2);

  // Disponibilidad
  const [disponible, setDisponible]   = useState<boolean | null>(null);
  const [motivoError, setMotivoError] = useState<string | null>(null);
  const [chequeando, setChequeando]   = useState(false);

  // Step 2: datos
  const [nombre, setNombre]     = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail]       = useState('');
  const [notas, setNotas]       = useState('');

  // Submit
  const [enviando, setEnviando]     = useState(false);
  const [reservaOk, setReservaOk]   = useState<{ id: number; estado: string } | null>(null);
  const [idempotencyKey]            = useState(() => crypto.randomUUID());

  // Cancelar
  const [cancelId, setCancelId]       = useState('');
  const [cancelTel, setCancelTel]     = useState('');
  const [cancelando, setCancelando]   = useState(false);
  const [cancelOk, setCancelOk]       = useState(false);

  useEffect(() => {
    if (!slug) return;
    void (async () => {
      const { data, error } = await getReservasInfoPublico(slug);
      if (error) toast.error(error);
      setInfo(data);
      setCargando(false);
    })();
  }, [slug]);

  const fechaHoraISO = fecha && hora
    ? new Date(`${fecha}T${hora}:00`).toISOString()
    : null;

  // Live check de disponibilidad al cambiar fecha/hora/personas
  useEffect(() => {
    if (!fechaHoraISO || !slug) {
      setDisponible(null);
      setMotivoError(null);
      return;
    }
    const t = setTimeout(async () => {
      setChequeando(true);
      const { data, error } = await checkDisponibilidadReserva({ slug, fechaHora: fechaHoraISO, personas });
      setChequeando(false);
      if (error) { setDisponible(false); setMotivoError(error); return; }
      setDisponible(data?.disponible ?? false);
      setMotivoError(data?.disponible ? null : (data?.motivo ?? null));
    }, 400);
    return () => clearTimeout(t);
  }, [fechaHoraISO, personas, slug]);

  async function handleReservar() {
    if (!fechaHoraISO || !slug) return;
    if (!disponible) { toast.error(ERRORES[motivoError ?? ''] ?? motivoError ?? 'Sin disponibilidad'); return; }
    if (nombre.trim().length < 2) { toast.error('Cargá tu nombre'); return; }
    if (info?.telefono_obligatorio && telefono.trim().length < 6) {
      toast.error('El teléfono es obligatorio para este local'); return;
    }
    setEnviando(true);
    const { data, error } = await crearReservaPublica({
      slug,
      clienteNombre: nombre.trim(),
      clienteTelefono: telefono.trim() || undefined,
      clienteEmail: email.trim() || undefined,
      fechaHora: fechaHoraISO,
      personas,
      notas: notas.trim() || undefined,
      idempotencyKey,
    });
    setEnviando(false);
    if (error || !data) {
      toast.error(ERRORES[error ?? ''] ?? error ?? 'No pudimos crear la reserva');
      return;
    }
    setReservaOk(data);
    setPaso('ok');
  }

  async function handleCancelar() {
    if (!slug) return;
    const id = parseInt(cancelId.replace('#', '').trim(), 10);
    if (!id || isNaN(id)) { toast.error('Código inválido'); return; }
    if (!cancelTel.trim()) { toast.error('Ingresá tu teléfono'); return; }
    setCancelando(true);
    const { ok, error } = await cancelarReservaPublica({ reservaId: id, telefono: cancelTel.trim() });
    setCancelando(false);
    if (!ok) { toast.error(error ?? 'No pudimos cancelar — verificá el código y el teléfono'); return; }
    setCancelOk(true);
  }

  // Slots de horario para la fecha seleccionada
  const slotsDelDia: string[] = (() => {
    if (!fecha || !info) return [];
    const dow = new Date(fecha + 'T00:00:00').getDay();
    const horario = info.horarios.find((h) => h.dia === dow);
    if (!horario) return [];
    return generarSlots(horario.abre, horario.cierra, info.duracion_estimada_min);
  })();

  const diasHabilitados = info?.horarios.map((h) => h.dia) ?? [];
  const minFecha = addDays(hoy(), Math.ceil((info?.anticipacion_min_hs ?? 0) / 24));
  const maxFecha = addDays(hoy(), info?.anticipacion_max_dias ?? 30);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (cargando) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Cargando…</p>
      </div>
    );
  }

  if (!info || !info.activas) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6 text-center">
        <CalendarCheck className="h-14 w-14 text-muted-foreground/30 mb-4" />
        <h1 className="text-xl font-semibold">{info?.local_nombre ?? 'Este local'}</h1>
        <p className="text-sm text-muted-foreground mt-2">No toma reservas online en este momento.</p>
      </div>
    );
  }

  // ── PASO OK ─────────────────────────────────────────────────────────────────
  if (paso === 'ok' && reservaOk) {
    return (
      <Shell info={info}>
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 mx-auto">
            <Check className="h-8 w-8" strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="text-xl font-semibold">
              {reservaOk.estado === 'confirmada' ? '¡Reserva confirmada!' : 'Reserva enviada'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {reservaOk.estado === 'confirmada'
                ? `Te esperamos el ${fmtFechaHora(fecha!, hora!)} para ${personas} persona${personas === 1 ? '' : 's'}.`
                : 'El local va a confirmar tu reserva a la brevedad. ¡Gracias!'}
            </p>
          </div>

          <div className="bg-muted rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Código de reserva</p>
            <p className="text-3xl font-mono font-bold">#{reservaOk.id}</p>
            <p className="text-xs text-muted-foreground mt-1">Guardalo para cancelar o modificar</p>
          </div>

          <div className="border-t pt-4 text-sm text-muted-foreground">
            <p className="mb-3">¿Necesitás cancelar?</p>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setCancelId(`#${reservaOk.id}`);
                setCancelTel(telefono);
                setPaso('cancelar');
              }}
            >
              Cancelar esta reserva
            </Button>
          </div>
        </div>
      </Shell>
    );
  }

  // ── CANCELAR ────────────────────────────────────────────────────────────────
  if (paso === 'cancelar') {
    if (cancelOk) {
      return (
        <Shell info={info}>
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 text-red-700 mx-auto">
              <X className="h-8 w-8" strokeWidth={2.5} />
            </div>
            <h2 className="text-xl font-semibold">Reserva cancelada</h2>
            <p className="text-sm text-muted-foreground">Lamentamos que no puedas venir. ¡Esperamos verte pronto!</p>
            <Button variant="outline" className="w-full" onClick={() => { setPaso('fecha'); setCancelOk(false); }}>
              Hacer nueva reserva
            </Button>
          </div>
        </Shell>
      );
    }
    return (
      <Shell info={info}>
        <div className="space-y-4">
          <button type="button" onClick={() => setPaso('fecha')}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" /> Volver
          </button>
          <h2 className="text-lg font-semibold">Cancelar reserva</h2>
          <p className="text-sm text-muted-foreground">
            Ingresá el código de tu reserva y el teléfono con el que la hiciste.
          </p>
          <div className="space-y-3">
            <div>
              <Label htmlFor="cancel-id">Código de reserva</Label>
              <Input id="cancel-id" value={cancelId} onChange={(e) => setCancelId(e.target.value)}
                     placeholder="#1234" className="mt-1 text-center font-mono text-lg" />
            </div>
            <div>
              <Label htmlFor="cancel-tel">Teléfono</Label>
              <Input id="cancel-tel" type="tel" value={cancelTel}
                     onChange={(e) => setCancelTel(e.target.value)}
                     placeholder="11 xxxx-xxxx" className="mt-1" />
            </div>
          </div>
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => void handleCancelar()}
            disabled={cancelando}
          >
            {cancelando ? 'Cancelando…' : 'Cancelar reserva'}
          </Button>
        </div>
      </Shell>
    );
  }

  // ── PASO FECHA ───────────────────────────────────────────────────────────────
  if (paso === 'fecha') {
    return (
      <Shell info={info}>
        <div className="space-y-5">
          {/* Personas */}
          <div className="flex items-center justify-between bg-muted rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-muted-foreground" /> Personas
            </div>
            <div className="flex items-center gap-3">
              <button type="button"
                      onClick={() => setPersonas((n) => Math.max(1, n - 1))}
                      className="h-8 w-8 rounded-full border bg-background flex items-center justify-center text-lg hover:bg-accent">
                −
              </button>
              <span className="text-lg font-semibold w-6 text-center">{personas}</span>
              <button type="button"
                      onClick={() => setPersonas((n) => Math.min(info.capacidad_max || 50, n + 1))}
                      className="h-8 w-8 rounded-full border bg-background flex items-center justify-center text-lg hover:bg-accent">
                +
              </button>
            </div>
          </div>

          {/* Calendario */}
          <MiniCalendario
            selected={fecha}
            min={minFecha}
            max={maxFecha}
            diasHabilitados={diasHabilitados}
            onSelect={(iso) => {
              setFecha(iso);
              setHora(null);
              setDisponible(null);
            }}
          />

          {/* Slots de horario */}
          {fecha && slotsDelDia.length === 0 && (
            <p className="text-sm text-center text-muted-foreground">
              Este día el local está cerrado.
            </p>
          )}

          {fecha && slotsDelDia.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                {fmtFechaLarga(fecha)}
              </p>
              <div className="grid grid-cols-4 gap-2">
                {slotsDelDia.map((slot) => {
                  const esSeleccionado = slot === hora;
                  return (
                    <button
                      key={slot}
                      type="button"
                      onClick={() => setHora(slot)}
                      className={cn(
                        'py-2 rounded-lg text-sm font-medium border transition-colors',
                        esSeleccionado
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-accent border-border',
                      )}
                    >
                      {slot}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Feedback disponibilidad */}
          {hora && (
            <div className={cn(
              'rounded-lg p-3 text-sm flex items-center gap-2',
              chequeando && 'bg-muted text-muted-foreground',
              !chequeando && disponible && 'bg-emerald-50 text-emerald-800 border border-emerald-200',
              !chequeando && disponible === false && 'bg-red-50 text-red-800 border border-red-200',
            )}>
              {chequeando
                ? <><Clock className="h-4 w-4 animate-pulse shrink-0" /> Verificando…</>
                : disponible
                ? <><Check className="h-4 w-4 shrink-0" /> ¡Hay lugar! 🎉</>
                : <><AlertCircle className="h-4 w-4 shrink-0" /> {ERRORES[motivoError ?? ''] ?? motivoError ?? 'Sin disponibilidad'}</>
              }
            </div>
          )}

          <Button
            className="w-full h-12 text-base"
            disabled={!fecha || !hora || !disponible}
            onClick={() => setPaso('datos')}
          >
            Continuar
          </Button>

          <button type="button"
                  className="w-full text-sm text-muted-foreground hover:underline"
                  onClick={() => setPaso('cancelar')}>
            ¿Querés cancelar una reserva?
          </button>
        </div>
      </Shell>
    );
  }

  // ── PASO DATOS ───────────────────────────────────────────────────────────────
  return (
    <Shell info={info}>
      <div className="space-y-4">
        {/* Resumen */}
        <button type="button"
                onClick={() => setPaso('fecha')}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" /> Cambiar fecha/hora
        </button>

        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-sm space-y-1">
          <p className="font-semibold text-primary">
            {fmtFechaHora(fecha!, hora!)}
          </p>
          <p className="text-muted-foreground">
            {personas} persona{personas === 1 ? '' : 's'} · {info.local_nombre}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <Label htmlFor="nombre">Nombre <span className="text-red-500">*</span></Label>
            <Input id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)}
                   className="mt-1" placeholder="Juan García" autoComplete="name" />
          </div>
          <div>
            <Label htmlFor="telefono">
              Teléfono {info.telefono_obligatorio && <span className="text-red-500">*</span>}
              {!info.telefono_obligatorio && <span className="text-muted-foreground text-xs"> (opcional)</span>}
            </Label>
            <Input id="telefono" type="tel" value={telefono}
                   onChange={(e) => setTelefono(e.target.value)}
                   className="mt-1" placeholder="11 5678 1234" autoComplete="tel" />
          </div>
          <div>
            <Label htmlFor="email">Email <span className="text-muted-foreground text-xs">(opcional)</span></Label>
            <Input id="email" type="email" value={email}
                   onChange={(e) => setEmail(e.target.value)}
                   className="mt-1" placeholder="juan@email.com" autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="notas">Notas <span className="text-muted-foreground text-xs">(opcional)</span></Label>
            <Textarea id="notas" value={notas} onChange={(e) => setNotas(e.target.value)}
                      className="mt-1 resize-none" rows={2}
                      placeholder="Alergias, cumpleaños, silla para bebé…" />
          </div>
        </div>

        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={() => void handleReservar()}
          disabled={enviando || !nombre.trim()}
        >
          {enviando ? 'Enviando…' : info.requiere_confirmacion ? 'Pedir reserva' : '✓ Confirmar reserva'}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          {info.requiere_confirmacion
            ? 'El local confirmará tu reserva a la brevedad.'
            : 'Tu reserva queda confirmada al instante.'}
        </p>
      </div>
    </Shell>
  );
}
