// TiendaReservar — formulario público de reserva en /tienda/:slug/reservar.
//
// Flow:
//   1. Cliente entra → carga config del local (¿activas? horarios, capacidad).
//   2. Elige fecha + hora + N personas.
//   3. Live: check de disponibilidad mientras tipea.
//   4. Carga nombre + tel + email → click "Reservar".
//   5. Pantalla "Listo, te avisamos por mail" + opción cancelar con código.

import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { CalendarCheck, Users, Clock, AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  getReservasInfoPublico, checkDisponibilidadReserva, crearReservaPublica,
  type ReservasInfoPublico,
} from '@/services/reservasService';
import type { TiendaCtx } from './TiendaLayout';

const MOTIVO_LABELS: Record<string, string> = {
  LOCAL_NO_ENCONTRADO: 'Este local no existe',
  RESERVAS_DESACTIVADAS: 'Este local no toma reservas online por ahora',
  PERSONAS_INVALIDAS: 'Cantidad de personas inválida (1-50)',
  ANTICIPACION_INSUFICIENTE: 'Necesitamos al menos {anticipacion_min_hs}hs de anticipación',
  FECHA_DEMASIADO_LEJANA: 'Solo aceptamos reservas hasta {anticipacion_max_dias} días en el futuro',
  SIN_CUPO: 'No queda lugar para esa fecha y hora 😔 Probá otro horario',
  TELEFONO_REQUERIDO: 'El teléfono es obligatorio',
  NOMBRE_REQUERIDO: 'El nombre es obligatorio (mínimo 2 letras)',
};

export function TiendaReservar() {
  const { local } = useOutletContext<TiendaCtx>();
  const { localSlug } = useParams<{ localSlug: string }>();
  const slug = localSlug ?? local.slug;

  const [info, setInfo] = useState<ReservasInfoPublico | null>(null);
  const [loading, setLoading] = useState(true);

  // Form fields
  const [fecha, setFecha] = useState('');
  const [hora, setHora] = useState('20:00');
  const [personas, setPersonas] = useState(2);
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [notas, setNotas] = useState('');

  // Disponibilidad
  const [chequeando, setChequeando] = useState(false);
  const [disponible, setDisponible] = useState<boolean | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);

  // Submit
  const [enviando, setEnviando] = useState(false);
  const [reservaCreada, setReservaCreada] = useState<{ id: number; estado: string } | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    (async () => {
      const { data, error } = await getReservasInfoPublico(slug);
      if (error) toast.error(error);
      setInfo(data);
      setLoading(false);
    })();
  }, [slug]);

  const fechaHoraISO = fecha && hora ? new Date(`${fecha}T${hora}:00`).toISOString() : null;

  // Disponibilidad live (debounced 500ms)
  useEffect(() => {
    if (!fechaHoraISO || !personas) {
      setDisponible(null);
      setMotivo(null);
      return;
    }
    const t = setTimeout(async () => {
      setChequeando(true);
      const { data, error } = await checkDisponibilidadReserva({
        slug, fechaHora: fechaHoraISO, personas,
      });
      setChequeando(false);
      if (error) {
        setMotivo(error);
        setDisponible(false);
        return;
      }
      if (data) {
        setDisponible(data.disponible);
        setMotivo(data.disponible ? null : data.motivo);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [fechaHoraISO, personas, slug]);

  async function handleReservar() {
    if (!fechaHoraISO) { toast.error('Elegí fecha y hora'); return; }
    if (!disponible) { toast.error(MOTIVO_LABELS[motivo ?? ''] ?? motivo ?? 'Sin disponibilidad'); return; }
    if (nombre.trim().length < 2) { toast.error('Cargá tu nombre'); return; }
    if (info?.telefono_obligatorio && telefono.trim().length < 6) {
      toast.error('Cargá tu teléfono'); return;
    }

    setEnviando(true);
    const { data, error } = await crearReservaPublica({
      slug,
      clienteNombre: nombre,
      clienteTelefono: telefono,
      clienteEmail: email || undefined,
      fechaHora: fechaHoraISO,
      personas,
      notas: notas || undefined,
      idempotencyKey,
    });
    setEnviando(false);
    if (error || !data) {
      toast.error(MOTIVO_LABELS[error ?? ''] ?? error ?? 'No pudimos crear la reserva');
      return;
    }
    setReservaCreada({ id: data.id, estado: data.estado });
    // Guardar teléfono para que pueda cancelar después
    sessionStorage.setItem(`reserva-tel-${data.id}`, telefono);
  }

  if (loading) {
    return <div className="p-12 text-center text-foreground/60">Cargando…</div>;
  }

  if (!info || !info.activas) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <CalendarCheck className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
        <h2 className="text-xl font-medium">Este local no toma reservas online</h2>
        <p className="text-sm text-foreground/60 mt-3">
          Probá llamando al local directamente{local.telefono ? `: ${local.telefono}` : ''}.
        </p>
        <Link to={`/tienda/${slug}`} className="inline-block mt-6 text-sm underline text-primary">
          Volver
        </Link>
      </div>
    );
  }

  // Pantalla post-reserva
  if (reservaCreada) {
    return (
      <div className="max-w-md mx-auto p-6 text-center space-y-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 text-green-700">
          <Check className="h-8 w-8" strokeWidth={3} />
        </div>
        <h1 className="text-2xl font-medium">
          {reservaCreada.estado === 'confirmada' ? '¡Reserva confirmada!' : 'Reserva enviada'}
        </h1>
        <p className="text-sm text-foreground/70">
          {reservaCreada.estado === 'confirmada'
            ? `Te esperamos el ${new Date(fechaHoraISO!).toLocaleString('es-AR', {
                weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
              })} para ${personas} persona${personas === 1 ? '' : 's'}.`
            : 'El local va a confirmar tu reserva en breve. Te avisamos por mail/WhatsApp.'}
        </p>
        <div className="bg-gray-50 rounded-md p-4 text-sm">
          <div className="text-xs uppercase tracking-wide text-foreground/60">Código reserva</div>
          <div className="font-mono text-lg mt-1">#{reservaCreada.id}</div>
        </div>
        {info.notas_publicas && (
          <div className="text-xs text-foreground/60 pt-4 border-t">{info.notas_publicas}</div>
        )}
        <Link to={`/tienda/${slug}`}>
          <Button variant="outline" className="w-full">Volver al menú</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-5 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-medium flex items-center gap-2">
          <CalendarCheck className="h-6 w-6" />
          Reservar mesa
        </h1>
        <p className="text-sm text-foreground/60 mt-1">{info.local_nombre}</p>
        {info.notas_publicas && (
          <p className="text-xs text-foreground/70 mt-2 p-2 bg-amber-50 rounded">{info.notas_publicas}</p>
        )}
      </div>

      {/* Fecha + Hora */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="fecha">Fecha</Label>
          <Input
            id="fecha" type="date" value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            min={new Date(Date.now() + info.anticipacion_min_hs * 3600_000).toISOString().slice(0, 10)}
            max={new Date(Date.now() + info.anticipacion_max_dias * 86400_000).toISOString().slice(0, 10)}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="hora">Hora</Label>
          <Input
            id="hora" type="time" value={hora}
            onChange={(e) => setHora(e.target.value)}
            className="mt-1"
          />
        </div>
      </div>

      {/* Personas */}
      <div>
        <Label htmlFor="personas" className="flex items-center gap-1">
          <Users className="h-4 w-4" /> Personas
        </Label>
        <div className="flex items-center gap-2 mt-1">
          <Button variant="outline" size="sm" type="button"
                  onClick={() => setPersonas((n) => Math.max(1, n - 1))}>−</Button>
          <Input id="personas" type="number" min="1" max="50" value={personas}
                 onChange={(e) => setPersonas(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                 className="text-center w-20" />
          <Button variant="outline" size="sm" type="button"
                  onClick={() => setPersonas((n) => Math.min(50, n + 1))}>+</Button>
        </div>
      </div>

      {/* Disponibilidad feedback */}
      {fechaHoraISO && (
        <div className={`p-3 rounded-md text-sm flex items-start gap-2 ${
          disponible === null ? 'bg-gray-50 text-foreground/70' :
          disponible ? 'bg-green-50 text-green-800' :
          'bg-red-50 text-red-800'
        }`}>
          {chequeando ? (
            <><Clock className="h-4 w-4 animate-pulse" /> Verificando disponibilidad…</>
          ) : disponible ? (
            <><Check className="h-4 w-4" /> Sí, hay lugar 👍</>
          ) : disponible === false ? (
            <><AlertCircle className="h-4 w-4" /> {MOTIVO_LABELS[motivo ?? '']
              ?.replace('{anticipacion_min_hs}', String(info.anticipacion_min_hs))
              ?.replace('{anticipacion_max_dias}', String(info.anticipacion_max_dias))
              ?? motivo ?? 'Sin disponibilidad'}</>
          ) : null}
        </div>
      )}

      {/* Datos cliente */}
      <div className="space-y-3 pt-2 border-t">
        <div>
          <Label htmlFor="nombre">Nombre</Label>
          <Input id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)}
                 className="mt-1" placeholder="Juan Pérez" />
        </div>
        <div>
          <Label htmlFor="telefono">
            Teléfono {info.telefono_obligatorio && <span className="text-red-600">*</span>}
          </Label>
          <Input id="telefono" type="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)}
                 className="mt-1" placeholder="11 5678 1234" />
        </div>
        <div>
          <Label htmlFor="email">Email (opcional)</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                 className="mt-1" placeholder="juan@example.com" />
        </div>
        <div>
          <Label htmlFor="notas">Notas (opcional)</Label>
          <Textarea id="notas" value={notas} onChange={(e) => setNotas(e.target.value)}
                    className="mt-1" rows={2} placeholder="Alergias, ocasión especial, etc." />
        </div>
      </div>

      <Button
        onClick={handleReservar}
        disabled={!disponible || enviando}
        className="w-full h-12"
      >
        {enviando ? 'Enviando…' : info.requiere_confirmacion ? 'Pedir reserva' : 'Confirmar reserva'}
      </Button>
    </div>
  );
}
