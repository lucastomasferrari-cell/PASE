// ReservasAdmin — pantalla para gestionar reservas online.
//
// Tabs:
//   - Hoy/Próximas: lo importante para operar el día.
//   - Pendientes confirmación: si el local requiere confirmación manual.
//   - En mesa: reservas sentadas (modelo v3 — se finalizan solas al cobrar).
//   - Histórico: todas con filtros.
//
// Acciones por reserva:
//   - Confirmar (si está pendiente)
//   - Sentar (el cliente llegó — estado 'sentada', con mesa opcional)
//   - Finalizar (cierre manual; al cobrar el ticket se finaliza sola)
//   - Marcar no-show (no apareció)
//   - Cancelar con motivo
//   - WhatsApp directo al cliente

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarCheck, Phone, MessageCircle, Check, X,
  Clock, Users, RefreshCw, Plus, Pencil, Armchair,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  listReservas, cambiarEstadoReserva, asignarMesaReserva, listMesasDelLocal,
  crearReserva, editarReserva,
  type Reserva, type EstadoReserva, type MesaSimple,
} from '@/services/reservasService';
import { whatsAppUrl, mensajeGenericoCliente } from '@/lib/whatsapp';

const ESTADO_COLORS: Record<EstadoReserva, string> = {
  pendiente:  'bg-amber-100 text-amber-800',
  confirmada: 'bg-green-100 text-green-800',
  sentada:    'bg-indigo-100 text-indigo-800',
  finalizada: 'bg-sky-100 text-sky-800',
  no_show:    'bg-red-100 text-red-800',
  cancelada:  'bg-gray-100 text-gray-700',
};

const ESTADO_LABELS: Record<EstadoReserva, string> = {
  pendiente:  '⏳ Pendiente',
  confirmada: '✓ Confirmada',
  sentada:    '🪑 En mesa',
  finalizada: '✅ Finalizada',
  no_show:    '❌ No show',
  cancelada:  '🚫 Cancelada',
};

function fmtFechaCorta(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtHora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

// yyyy-mm-dd local (para <input type="date"> y para agrupar la agenda por día).
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Form de alta/edición (MESA módulo #1) ─────────────────────────────────
interface ReservaFormState {
  nombre: string; telefono: string; email: string;
  fecha: string;   // yyyy-mm-dd
  hora: string;    // HH:mm
  personas: string;
  notas: string;
}

function reservaToForm(r: Reserva | null, fechaDefault: string): ReservaFormState {
  if (!r) return { nombre: '', telefono: '', email: '', fecha: fechaDefault, hora: '20:00', personas: '2', notas: '' };
  const d = new Date(r.fecha_hora);
  return {
    nombre: r.cliente_nombre ?? '',
    telefono: r.cliente_telefono ?? '',
    email: r.cliente_email ?? '',
    fecha: toLocalDateStr(d),
    hora: d.toTimeString().slice(0, 5),
    personas: String(r.personas ?? 2),
    notas: r.notas ?? '',
  };
}

export function ReservasAdmin() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [mesas, setMesas] = useState<MesaSimple[]>([]);  // F5 Chunk D
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!localActivo) return;
    setRefreshing(true);
    const { data, error } = await listReservas({
      localId: localActivo,
      desde: new Date(Date.now() - 7 * 86400_000).toISOString(),
      limit: 500,
    });
    if (error) toast.error(error);
    else setReservas(data);
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => { void reload(); }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  // F5 Chunk D: cargar mesas del local para el dropdown de asignación.
  // Se recargan cuando cambia el local — no tienen polling porque las
  // mesas son master data que no cambia frecuente.
  useEffect(() => {
    if (!localActivo) return;
    void (async () => {
      const { data } = await listMesasDelLocal(localActivo);
      setMesas(data);
    })();
  }, [localActivo]);

  async function handleAsignarMesa(r: Reserva, mesaId: number) {
    setBusy(r.id);
    const { error } = await asignarMesaReserva({ reservaId: r.id, mesaId });
    setBusy(null);
    if (error) toast.error(error);
    else {
      toast.success(`Mesa asignada a #${r.id}`);
      void reload();
    }
  }

  const now = Date.now();
  const grupos = useMemo(() => {
    return {
      pendientes: reservas.filter((r) => r.estado === 'pendiente'),
      proximas: reservas.filter((r) =>
        r.estado === 'confirmada' && new Date(r.fecha_hora).getTime() > now - 3600_000
      ).sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)),
      enMesa: reservas.filter((r) => r.estado === 'sentada')
        .sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)),
      historico: reservas.filter((r) =>
        r.estado === 'finalizada' || r.estado === 'no_show' || r.estado === 'cancelada' ||
        (r.estado === 'confirmada' && new Date(r.fecha_hora).getTime() <= now - 3600_000)
      ).sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora)),
    };
  }, [reservas, now]);

  async function cambiarEstado(r: Reserva, nuevoEstado: 'confirmada' | 'sentada' | 'finalizada' | 'no_show' | 'cancelada', motivo?: string) {
    setBusy(r.id);
    const { error } = await cambiarEstadoReserva({
      reservaId: r.id,
      nuevoEstado,
      motivo,
    });
    setBusy(null);
    if (error) toast.error(error);
    else {
      toast.success(`Reserva #${r.id} → ${ESTADO_LABELS[nuevoEstado]}`);
      void reload();
    }
  }

  async function handleConfirmar(r: Reserva) { await cambiarEstado(r, 'confirmada'); }
  async function handleNoShow(r: Reserva) {
    if (!confirm(`Marcar reserva #${r.id} (${r.cliente_nombre}) como NO SHOW?`)) return;
    await cambiarEstado(r, 'no_show');
  }
  async function handleCancelar(r: Reserva) {
    const motivo = prompt('Motivo de cancelación (opcional):');
    if (motivo === null) return; // canceló el prompt
    await cambiarEstado(r, 'cancelada', motivo || undefined);
  }
  // Cierre manual de una reserva sentada. Normalmente no hace falta:
  // al cobrar el ticket linkeado, el backend la finaliza solo.
  async function handleFinalizar(r: Reserva) { await cambiarEstado(r, 'finalizada'); }

  // ── MESA módulo #1: agenda por día + alta/edición + sentar con mesa ──────
  const [agendaFecha, setAgendaFecha] = useState<string>(toLocalDateStr(new Date()));
  const agenda = useMemo(() =>
    reservas
      .filter((r) => toLocalDateStr(new Date(r.fecha_hora)) === agendaFecha)
      .sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)),
  [reservas, agendaFecha]);

  // Form de alta/edición. editTarget=null → alta.
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Reserva | null>(null);
  const [form, setForm] = useState<ReservaFormState>(reservaToForm(null, toLocalDateStr(new Date())));
  const [saving, setSaving] = useState(false);

  function abrirAlta() {
    setEditTarget(null);
    setForm(reservaToForm(null, agendaFecha));
    setFormOpen(true);
  }
  function abrirEdicion(r: Reserva) {
    setEditTarget(r);
    setForm(reservaToForm(r, agendaFecha));
    setFormOpen(true);
  }

  async function guardarForm() {
    if (!localActivo) return;
    if (!form.nombre.trim()) { toast.error('El nombre es obligatorio'); return; }
    const personas = parseInt(form.personas, 10);
    if (!Number.isFinite(personas) || personas < 1 || personas > 50) {
      toast.error('Personas: entre 1 y 50'); return;
    }
    if (!form.fecha || !form.hora) { toast.error('Fecha y hora son obligatorias'); return; }
    const fechaHora = new Date(`${form.fecha}T${form.hora}:00`);
    if (isNaN(fechaHora.getTime())) { toast.error('Fecha/hora inválida'); return; }
    setSaving(true);
    try {
      if (editTarget) {
        const { error } = await editarReserva({
          reservaId: editTarget.id,
          clienteNombre: form.nombre.trim(),
          clienteTelefono: form.telefono.trim(),
          clienteEmail: form.email.trim(),
          fechaHora: fechaHora.toISOString(),
          personas,
          notas: form.notas,
        });
        if (error) { toast.error(error); return; }
        toast.success(`Reserva #${editTarget.id} actualizada`);
      } else {
        const { id, error } = await crearReserva({
          localId: localActivo,
          clienteNombre: form.nombre.trim(),
          clienteTelefono: form.telefono.trim() || undefined,
          clienteEmail: form.email.trim() || undefined,
          fechaHora: fechaHora.toISOString(),
          personas,
          notas: form.notas || undefined,
          idempotencyKey: `manual-${localActivo}-${form.nombre.trim()}-${form.fecha}T${form.hora}`,
        });
        if (error) { toast.error(error); return; }
        toast.success(`Reserva #${id} creada`);
        setAgendaFecha(form.fecha); // saltar la agenda al día de la reserva nueva
      }
      setFormOpen(false);
      void reload();
    } finally {
      setSaving(false);
    }
  }

  // Sentar (estado 'sentada') con mesa opcional en un paso.
  const [sentarTarget, setSentarTarget] = useState<Reserva | null>(null);
  const [sentarMesa, setSentarMesa] = useState<string>('');
  function abrirSentar(r: Reserva) {
    setSentarTarget(r);
    setSentarMesa(r.mesa_id ? String(r.mesa_id) : '');
  }
  async function confirmarSentar() {
    if (!sentarTarget) return;
    const mesaId = sentarMesa ? parseInt(sentarMesa, 10) : undefined;
    setBusy(sentarTarget.id);
    const { error } = await cambiarEstadoReserva({
      reservaId: sentarTarget.id, nuevoEstado: 'sentada', mesaId,
    });
    setBusy(null);
    if (error) { toast.error(error); return; }
    toast.success(`${sentarTarget.cliente_nombre} sentado${mesaId ? ' — mesa asignada' : ''}`);
    setSentarTarget(null);
    void reload();
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando reservas…</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <CalendarCheck className="h-6 w-6" />
            Reservas
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Pendientes: {grupos.pendientes.length} · Próximas: {grupos.proximas.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={abrirAlta}>
            <Plus className="h-4 w-4 mr-1" /> Nueva reserva
          </Button>
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="agenda" className="w-full">
        <TabsList>
          <TabsTrigger value="agenda">Agenda</TabsTrigger>
          <TabsTrigger value="pendientes">
            Pendientes confirmación {grupos.pendientes.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-xs">
                {grupos.pendientes.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="proximas">Próximas ({grupos.proximas.length})</TabsTrigger>
          <TabsTrigger value="enmesa">
            En mesa {grupos.enMesa.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-indigo-200 text-indigo-900 text-xs">
                {grupos.enMesa.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="historico">Histórico ({grupos.historico.length})</TabsTrigger>
        </TabsList>

        {/* ── MESA módulo #1: agenda del día ─────────────────────────────── */}
        <TabsContent value="agenda" className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={agendaFecha}
              onChange={(e) => setAgendaFecha(e.target.value)}
              className="w-44"
            />
            <Button variant="ghost" size="sm" onClick={() => setAgendaFecha(toLocalDateStr(new Date()))}>
              Hoy
            </Button>
            <span className="text-sm text-foreground/60">
              {agenda.length} reserva{agenda.length === 1 ? '' : 's'} ·{' '}
              {agenda.reduce((s, r) => s + (r.estado !== 'cancelada' && r.estado !== 'no_show' ? r.personas : 0), 0)} cubiertos
            </span>
          </div>
          {agenda.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-foreground/60">
                Sin reservas para este día. Cargá una con “Nueva reserva”.
              </CardContent>
            </Card>
          ) : agenda.map((r) => (
            <ReservaRow key={r.id} reserva={r} busy={busy === r.id}
                        mesas={mesas}
                        horaSola
                        onConfirmar={r.estado === 'pendiente' ? () => handleConfirmar(r) : undefined}
                        onSentar={r.estado === 'pendiente' || r.estado === 'confirmada' ? () => abrirSentar(r) : undefined}
                        onFinalizar={r.estado === 'sentada' ? () => handleFinalizar(r) : undefined}
                        onNoShow={r.estado === 'confirmada' ? () => handleNoShow(r) : undefined}
                        onCancelar={r.estado === 'pendiente' || r.estado === 'confirmada' ? () => handleCancelar(r) : undefined}
                        onEditar={r.estado === 'pendiente' || r.estado === 'confirmada' ? () => abrirEdicion(r) : undefined}
                        readOnly={r.estado === 'finalizada' || r.estado === 'no_show' || r.estado === 'cancelada'} />
          ))}
        </TabsContent>

        <TabsContent value="pendientes" className="mt-4 space-y-2">
          {grupos.pendientes.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-foreground/60">
                <Check className="h-10 w-10 mx-auto text-green-500 mb-2" />
                Sin reservas pendientes de confirmación.
              </CardContent>
            </Card>
          ) : grupos.pendientes.map((r) => (
            <ReservaRow key={r.id} reserva={r} busy={busy === r.id}
                        mesas={mesas}
                        onConfirmar={() => handleConfirmar(r)}
                        onCancelar={() => handleCancelar(r)}
                        onEditar={() => abrirEdicion(r)}
                        onAsignarMesa={(mesaId) => handleAsignarMesa(r, mesaId)} />
          ))}
        </TabsContent>

        <TabsContent value="proximas" className="mt-4 space-y-2">
          {grupos.proximas.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-foreground/60">
                Sin reservas próximas.
              </CardContent>
            </Card>
          ) : grupos.proximas.map((r) => (
            <ReservaRow key={r.id} reserva={r} busy={busy === r.id}
                        mesas={mesas}
                        onSentar={() => abrirSentar(r)}
                        onNoShow={() => handleNoShow(r)}
                        onCancelar={() => handleCancelar(r)}
                        onEditar={() => abrirEdicion(r)}
                        onAsignarMesa={(mesaId) => handleAsignarMesa(r, mesaId)} />
          ))}
        </TabsContent>

        {/* ── Modelo v3: reservas sentadas (en mesa ahora) ───────────────── */}
        <TabsContent value="enmesa" className="mt-4 space-y-2">
          {grupos.enMesa.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-foreground/60">
                Nadie en mesa por reserva ahora.
              </CardContent>
            </Card>
          ) : (
            <>
              <p className="text-xs text-foreground/60">
                Al cobrar el ticket de la mesa, la reserva se finaliza sola. “Finalizar” es solo para cerrarla a mano.
              </p>
              {grupos.enMesa.map((r) => (
                <ReservaRow key={r.id} reserva={r} busy={busy === r.id}
                            mesas={mesas}
                            onFinalizar={() => handleFinalizar(r)} />
              ))}
            </>
          )}
        </TabsContent>

        <TabsContent value="historico" className="mt-4 space-y-2">
          {grupos.historico.map((r) => (
            <ReservaRow key={r.id} reserva={r} mesas={mesas} readOnly />
          ))}
        </TabsContent>
      </Tabs>

      {/* ── Modal alta/edición (MESA módulo #1) ──────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={(o) => !saving && setFormOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editTarget ? `Editar reserva #${editTarget.id}` : 'Nueva reserva'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rv-nombre">Nombre *</Label>
              <Input id="rv-nombre" value={form.nombre} autoFocus
                     onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="rv-tel">Teléfono</Label>
                <Input id="rv-tel" value={form.telefono} inputMode="tel"
                       onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rv-email">Email</Label>
                <Input id="rv-email" value={form.email} inputMode="email"
                       onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="rv-fecha">Fecha *</Label>
                <Input id="rv-fecha" type="date" value={form.fecha}
                       onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rv-hora">Hora *</Label>
                <Input id="rv-hora" type="time" value={form.hora}
                       onChange={(e) => setForm((f) => ({ ...f, hora: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rv-pers">Personas *</Label>
                <Input id="rv-pers" type="number" min={1} max={50} value={form.personas}
                       onChange={(e) => setForm((f) => ({ ...f, personas: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rv-notas">Notas</Label>
              <Textarea id="rv-notas" value={form.notas} rows={2}
                        placeholder="Alergias, cumpleaños, mesa preferida…"
                        onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={() => void guardarForm()} disabled={saving}>
              {saving ? 'Guardando…' : editTarget ? 'Guardar cambios' : 'Crear reserva'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal sentar con mesa opcional ───────────────────────────────── */}
      <Dialog open={!!sentarTarget} onOpenChange={(o) => !o && setSentarTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Sentar a {sentarTarget?.cliente_nombre}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="rv-mesa">Mesa (opcional)</Label>
            <select
              id="rv-mesa"
              className="text-sm px-2 py-2 rounded border border-border bg-background"
              value={sentarMesa}
              onChange={(e) => setSentarMesa(e.target.value)}
            >
              <option value="">— sin mesa —</option>
              {mesas.map((m) => (
                <option key={m.id} value={m.id}>
                  Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}{m.capacidad ? ` · ${m.capacidad}p` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-foreground/60">
              {sentarTarget?.personas} persona{(sentarTarget?.personas ?? 0) === 1 ? '' : 's'} · {sentarTarget ? fmtHora(sentarTarget.fecha_hora) : ''}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSentarTarget(null)}>Cancelar</Button>
            <Button onClick={() => void confirmarSentar()} disabled={busy === sentarTarget?.id}>
              <Armchair className="h-4 w-4 mr-1" /> Sentar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReservaRow({
  reserva: r, busy, mesas, horaSola, onConfirmar, onSentar, onFinalizar, onNoShow, onCancelar, onEditar, onAsignarMesa, readOnly,
}: {
  reserva: Reserva;
  busy?: boolean;
  mesas?: MesaSimple[];
  /** En la agenda (que ya es de UN día) mostrar solo la hora, no la fecha. */
  horaSola?: boolean;
  onConfirmar?: () => void;
  onSentar?: () => void;
  onFinalizar?: () => void;
  onNoShow?: () => void;
  onCancelar?: () => void;
  onEditar?: () => void;
  onAsignarMesa?: (mesaId: number) => void;
  readOnly?: boolean;
}) {
  const wpUrl = whatsAppUrl(r.cliente_telefono, mensajeGenericoCliente(r.cliente_nombre, r.id));
  // F5 Chunk D: nombre legible de la mesa asignada (si la hay)
  const mesaAsignada = mesas?.find((m) => m.id === r.mesa_id);
  const mesaLabel = mesaAsignada
    ? `Mesa ${mesaAsignada.numero}${mesaAsignada.zona ? ` (${mesaAsignada.zona})` : ''}`
    : null;
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{r.cliente_nombre}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ESTADO_COLORS[r.estado]}`}>
                {ESTADO_LABELS[r.estado]}
              </span>
              {r.estado === 'no_show' && r.no_show_auto && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200"
                      title="Marcada automáticamente por el sistema (pasó la hora + gracia sin sentarse)">
                  auto
                </span>
              )}
              <span className="text-xs text-foreground/60">#{r.id}</span>
              {mesaLabel && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 font-medium">
                  📍 {mesaLabel}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-foreground/70 mt-1">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> {horaSola ? fmtHora(r.fecha_hora) : fmtFechaCorta(r.fecha_hora)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {r.personas}
              </span>
              {r.duracion_min != null && (
                <span className="text-xs text-foreground/50" title="Duración estimada de la reserva">
                  ~{r.duracion_min} min
                </span>
              )}
              {r.cliente_telefono && (
                <a href={`tel:${r.cliente_telefono}`} className="flex items-center gap-1 hover:underline text-primary">
                  <Phone className="h-3.5 w-3.5" /> {r.cliente_telefono}
                </a>
              )}
              {wpUrl && (
                <a href={wpUrl} target="_blank" rel="noopener" className="flex items-center gap-1 hover:underline text-green-700">
                  <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                </a>
              )}
            </div>
            {r.notas && <p className="text-xs text-foreground/60 mt-1 italic">"{r.notas}"</p>}
            {r.motivo_cancelacion && <p className="text-xs text-red-700 mt-1">Cancelada: {r.motivo_cancelacion}</p>}
            {/* F5 Chunk D: dropdown asignar mesa (solo si pendiente/confirmada) */}
            {!readOnly && onAsignarMesa && mesas && mesas.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-foreground/60">
                  {mesaAsignada ? 'Cambiar mesa:' : 'Asignar mesa:'}
                </span>
                <select
                  className="text-xs px-2 py-1 rounded border border-border bg-background"
                  value={r.mesa_id ?? ''}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v !== r.mesa_id) onAsignarMesa(v);
                  }}
                  disabled={busy}
                >
                  <option value="">— sin asignar —</option>
                  {mesas.map((m) => (
                    <option key={m.id} value={m.id}>
                      Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}{m.capacidad ? ` · ${m.capacidad}p` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {!readOnly && (
            <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
              {onConfirmar && (
                <Button size="sm" onClick={onConfirmar} disabled={busy}>
                  <Check className="h-4 w-4 mr-1" /> Confirmar
                </Button>
              )}
              {onSentar && (
                <Button size="sm" variant="outline" onClick={onSentar} disabled={busy}>
                  <Armchair className="h-4 w-4 mr-1" /> Sentar
                </Button>
              )}
              {onFinalizar && (
                <Button size="sm" variant="outline" onClick={onFinalizar} disabled={busy}
                        title="Cierre manual — al cobrar el ticket se finaliza sola">
                  <Check className="h-4 w-4 mr-1" /> Finalizar
                </Button>
              )}
              {onNoShow && (
                <Button size="sm" variant="outline" onClick={onNoShow} disabled={busy} className="text-red-700 hover:bg-red-50">
                  No show
                </Button>
              )}
              {onEditar && (
                <Button size="sm" variant="ghost" onClick={onEditar} disabled={busy} title="Editar reserva">
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {onCancelar && (
                <Button size="sm" variant="ghost" onClick={onCancelar} disabled={busy} className="text-red-700">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
