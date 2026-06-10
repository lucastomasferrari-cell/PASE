// EventosGiftcardsAdmin — MESA módulo #4 fase 2 (09-jun).
//
// Tres tabs:
//   Eventos   — crear/publicar eventos con prepago MP + ver inscripciones.
//   Giftcards — catálogo de giftcards + ventas (códigos y estados).
//   Canjear   — el staff valida un código GC-XXXXXXXX y lo marca canjeado.
//
// La plata la mueve el público (página pública + MP webhook) — acá se
// gestionan los catálogos y el canje.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarDays, Gift, Plus, Pencil, RefreshCw, TicketCheck, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { formatARS } from '@/lib/format';
import {
  listEventos, crearEvento, actualizarEvento, cambiarEstadoEvento, listInscripciones,
  listGiftcards, crearGiftcard, actualizarGiftcard, listComprasGiftcards, canjearGiftcard,
  type Evento, type EventoInscripcion, type EstadoEvento,
  type Giftcard, type GiftcardCompra, type CanjeResultado,
} from '@/services/eventosGiftcardsService';

const ESTADO_EVENTO_BADGE: Record<EstadoEvento, string> = {
  borrador:   'bg-gray-100 text-gray-700',
  publicado:  'bg-green-100 text-green-800',
  agotado:    'bg-amber-100 text-amber-800',
  finalizado: 'bg-sky-100 text-sky-800',
  cancelado:  'bg-red-100 text-red-800',
};

const ESTADO_COMPRA_BADGE: Record<GiftcardCompra['estado'], string> = {
  pendiente_pago: 'bg-amber-100 text-amber-800',
  pagada:         'bg-green-100 text-green-800',
  canjeada:       'bg-sky-100 text-sky-800',
  cancelada:      'bg-gray-100 text-gray-700',
};

function fmtFecha(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

interface EventoForm {
  titulo: string; descripcion: string; fecha: string; hora: string;
  precio: string; cupos: string; fotoUrl: string;
}
const EVENTO_FORM_VACIO: EventoForm = {
  titulo: '', descripcion: '', fecha: '', hora: '20:00', precio: '', cupos: '20', fotoUrl: '',
};

interface GiftForm {
  nombre: string; descripcion: string; precio: string; fotoUrl: string; todoElGrupo: boolean;
}
const GIFT_FORM_VACIO: GiftForm = { nombre: '', descripcion: '', precio: '', fotoUrl: '', todoElGrupo: false };

export function EventosGiftcardsAdmin() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const tenantId = user?.tenant_id ?? null;

  // ── Eventos ──────────────────────────────────────────────────────────────
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [evForm, setEvForm] = useState<EventoForm>(EVENTO_FORM_VACIO);
  const [evDialog, setEvDialog] = useState(false);
  const [evEdit, setEvEdit] = useState<Evento | null>(null);
  const [evSaving, setEvSaving] = useState(false);
  const [inscDe, setInscDe] = useState<Evento | null>(null);
  const [inscripciones, setInscripciones] = useState<EventoInscripcion[]>([]);

  // ── Giftcards ─────────────────────────────────────────────────────────────
  const [gifts, setGifts] = useState<Giftcard[]>([]);
  const [compras, setCompras] = useState<(GiftcardCompra & { giftcards: { nombre: string } | null })[]>([]);
  const [gForm, setGForm] = useState<GiftForm>(GIFT_FORM_VACIO);
  const [gDialog, setGDialog] = useState(false);
  const [gEdit, setGEdit] = useState<Giftcard | null>(null);
  const [gSaving, setGSaving] = useState(false);

  // ── Canje ─────────────────────────────────────────────────────────────────
  const [codigo, setCodigo] = useState('');
  const [canjeando, setCanjeando] = useState(false);
  const [canje, setCanje] = useState<CanjeResultado | null>(null);

  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!localActivo) return;
    const [ev, gc, cp] = await Promise.all([
      listEventos(localActivo), listGiftcards(localActivo), listComprasGiftcards(localActivo),
    ]);
    if (ev.error) toast.error(ev.error); else setEventos(ev.data);
    if (gc.error) toast.error(gc.error); else setGifts(gc.data);
    if (cp.error) toast.error(cp.error); else setCompras(cp.data);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Eventos: alta/edición ─────────────────────────────────────────────────
  function abrirEventoNuevo() {
    setEvEdit(null); setEvForm(EVENTO_FORM_VACIO); setEvDialog(true);
  }
  function abrirEventoEdicion(e: Evento) {
    const d = new Date(e.fecha_inicio);
    setEvEdit(e);
    setEvForm({
      titulo: e.titulo, descripcion: e.descripcion ?? '',
      fecha: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      hora: d.toTimeString().slice(0, 5),
      precio: String(Number(e.precio_por_persona)), cupos: String(e.cupos_total),
      fotoUrl: e.foto_url ?? '',
    });
    setEvDialog(true);
  }

  async function guardarEvento() {
    if (!localActivo || !tenantId) return;
    const precio = parseFloat(evForm.precio);
    const cupos = parseInt(evForm.cupos, 10);
    if (!evForm.titulo.trim()) { toast.error('El título es obligatorio'); return; }
    if (!evForm.fecha || !evForm.hora) { toast.error('Fecha y hora son obligatorias'); return; }
    if (!Number.isFinite(precio) || precio < 0) { toast.error('Precio inválido'); return; }
    if (!Number.isFinite(cupos) || cupos < 1) { toast.error('Cupos inválidos'); return; }
    if (evEdit && cupos < evEdit.cupos_vendidos) {
      toast.error(`Ya hay ${evEdit.cupos_vendidos} cupos vendidos — no podés bajar el total por debajo de eso`);
      return;
    }
    const fechaInicio = new Date(`${evForm.fecha}T${evForm.hora}:00`).toISOString();
    setEvSaving(true);
    try {
      const input = {
        titulo: evForm.titulo.trim(), descripcion: evForm.descripcion,
        fotoUrl: evForm.fotoUrl, fechaInicio, precioPorPersona: precio, cuposTotal: cupos,
      };
      const { error } = evEdit
        ? await actualizarEvento(evEdit.id, input)
        : await crearEvento(localActivo, tenantId, input);
      if (error) { toast.error(error); return; }
      toast.success(evEdit ? 'Evento actualizado' : 'Evento creado (en borrador — publicalo cuando esté listo)');
      setEvDialog(false);
      void reload();
    } finally { setEvSaving(false); }
  }

  async function cambiarEstado(e: Evento, estado: EstadoEvento) {
    if (estado === 'cancelado' && e.cupos_vendidos > 0 &&
        !confirm(`Este evento tiene ${e.cupos_vendidos} cupos VENDIDOS (plata cobrada). ¿Cancelar igual? Los reembolsos son manuales por ahora.`)) return;
    const { error } = await cambiarEstadoEvento(e.id, estado);
    if (error) { toast.error(error); return; }
    toast.success(`Evento → ${estado}`);
    void reload();
  }

  async function verInscripciones(e: Evento) {
    setInscDe(e);
    const { data, error } = await listInscripciones(e.id);
    if (error) toast.error(error); else setInscripciones(data);
  }

  // ── Giftcards: alta/edición ───────────────────────────────────────────────
  function abrirGiftNueva() { setGEdit(null); setGForm(GIFT_FORM_VACIO); setGDialog(true); }
  function abrirGiftEdicion(g: Giftcard) {
    setGEdit(g);
    setGForm({
      nombre: g.nombre, descripcion: g.descripcion ?? '',
      precio: String(Number(g.precio)), fotoUrl: g.foto_url ?? '',
      todoElGrupo: g.local_id === null,
    });
    setGDialog(true);
  }

  async function guardarGift() {
    if (!localActivo || !tenantId) return;
    const precio = parseFloat(gForm.precio);
    if (!gForm.nombre.trim()) { toast.error('El nombre es obligatorio'); return; }
    if (!Number.isFinite(precio) || precio <= 0) { toast.error('Precio inválido'); return; }
    setGSaving(true);
    try {
      const input = {
        nombre: gForm.nombre.trim(), descripcion: gForm.descripcion,
        fotoUrl: gForm.fotoUrl, precio, todoElGrupo: gForm.todoElGrupo,
      };
      const { error } = gEdit
        ? await actualizarGiftcard(gEdit.id, input)
        : await crearGiftcard(localActivo, tenantId, input);
      if (error) { toast.error(error); return; }
      toast.success(gEdit ? 'Giftcard actualizada' : 'Giftcard creada y activa');
      setGDialog(false);
      void reload();
    } finally { setGSaving(false); }
  }

  async function toggleGiftActiva(g: Giftcard) {
    const { error } = await actualizarGiftcard(g.id, { activa: !g.activa });
    if (error) { toast.error(error); return; }
    void reload();
  }

  // ── Canje ─────────────────────────────────────────────────────────────────
  async function handleCanjear() {
    const code = codigo.trim().toUpperCase();
    if (!code) { toast.error('Ingresá el código (GC-XXXXXXXX)'); return; }
    setCanjeando(true);
    setCanje(null);
    try {
      const { data, error } = await canjearGiftcard(code);
      if (error) { toast.error(error); return; }
      setCanje(data);
      setCodigo('');
      toast.success('Giftcard canjeada ✔');
      void reload();
    } finally { setCanjeando(false); }
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando…</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-medium flex items-center gap-2">
          <CalendarDays className="h-6 w-6" /> Eventos y Giftcards
        </h1>
        <Button variant="outline" size="sm" onClick={() => reload()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Tabs defaultValue="eventos" className="w-full">
        <TabsList>
          <TabsTrigger value="eventos">Eventos ({eventos.length})</TabsTrigger>
          <TabsTrigger value="giftcards">Giftcards ({gifts.length})</TabsTrigger>
          <TabsTrigger value="canjear"><TicketCheck className="h-4 w-4 mr-1" /> Canjear</TabsTrigger>
        </TabsList>

        {/* ── EVENTOS ─────────────────────────────────────────────────────── */}
        <TabsContent value="eventos" className="mt-4 space-y-2">
          <Button size="sm" onClick={abrirEventoNuevo}>
            <Plus className="h-4 w-4 mr-1" /> Nuevo evento
          </Button>
          {eventos.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-foreground/60">
              Sin eventos. Creá el primero — cena especial, omakase, aniversario…
              Los clientes pagan el cupo por adelantado con MercadoPago.
            </CardContent></Card>
          ) : eventos.map((e) => (
            <Card key={e.id}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{e.titulo}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ESTADO_EVENTO_BADGE[e.estado]}`}>{e.estado}</span>
                    </div>
                    <div className="text-sm text-foreground/70 mt-1 flex items-center gap-3 flex-wrap">
                      <span>{fmtFecha(e.fecha_inicio)}</span>
                      <span>{formatARS(Number(e.precio_por_persona))} / persona</span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" /> {e.cupos_vendidos}/{e.cupos_total} vendidos
                      </span>
                    </div>
                    {e.descripcion && <p className="text-xs text-foreground/60 mt-1">{e.descripcion}</p>}
                  </div>
                  <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                    {e.estado === 'borrador' && (
                      <Button size="sm" onClick={() => cambiarEstado(e, 'publicado')}>Publicar</Button>
                    )}
                    {(e.estado === 'publicado' || e.estado === 'agotado') && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => verInscripciones(e)}>Inscriptos</Button>
                        <Button size="sm" variant="outline" onClick={() => cambiarEstado(e, 'finalizado')}>Finalizar</Button>
                        <Button size="sm" variant="ghost" className="text-red-700" onClick={() => cambiarEstado(e, 'cancelado')}>Cancelar</Button>
                      </>
                    )}
                    {(e.estado === 'borrador' || e.estado === 'publicado') && (
                      <Button size="sm" variant="ghost" onClick={() => abrirEventoEdicion(e)} title="Editar"><Pencil className="h-4 w-4" /></Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ── GIFTCARDS ───────────────────────────────────────────────────── */}
        <TabsContent value="giftcards" className="mt-4 space-y-4">
          <div className="space-y-2">
            <Button size="sm" onClick={abrirGiftNueva}>
              <Plus className="h-4 w-4 mr-1" /> Nueva giftcard
            </Button>
            {gifts.length === 0 ? (
              <Card><CardContent className="p-10 text-center text-foreground/60">
                Sin giftcards. Creá la primera — "Dinner Card para 2", "Nikkei Experience"…
              </CardContent></Card>
            ) : gifts.map((g) => (
              <Card key={g.id}>
                <CardContent className="p-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Gift className="h-4 w-4 text-foreground/50" />
                      <span className="font-medium">{g.nombre}</span>
                      <span className="text-sm text-foreground/70">{formatARS(Number(g.precio))}</span>
                      {g.local_id === null && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">todo el grupo</span>
                      )}
                    </div>
                    {g.descripcion && <p className="text-xs text-foreground/60 mt-0.5">{g.descripcion}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={g.activa} onCheckedChange={() => toggleGiftActiva(g)} title={g.activa ? 'Activa (a la venta)' : 'Pausada'} />
                    <Button size="sm" variant="ghost" onClick={() => abrirGiftEdicion(g)}><Pencil className="h-4 w-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div>
            <h2 className="text-sm font-medium text-foreground/70 mb-2">Ventas ({compras.length})</h2>
            {compras.length === 0 ? (
              <p className="text-sm text-foreground/50">Todavía no se vendió ninguna.</p>
            ) : (
              <div className="space-y-1.5">
                {compras.map((c) => (
                  <Card key={c.id}>
                    <CardContent className="p-2.5 flex items-center justify-between gap-3 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{c.giftcards?.nombre ?? `Giftcard #${c.giftcard_id}`}</span>
                        <span className="text-foreground/60"> · {c.comprador_nombre}</span>
                        {c.para_nombre && <span className="text-foreground/60"> → {c.para_nombre}</span>}
                        {c.codigo && <span className="ml-2 font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{c.codigo}</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span>{formatARS(Number(c.monto))}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ESTADO_COMPRA_BADGE[c.estado]}`}>{c.estado.replace('_', ' ')}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── CANJEAR ─────────────────────────────────────────────────────── */}
        <TabsContent value="canjear" className="mt-4">
          <Card className="max-w-md">
            <CardContent className="p-5 space-y-3">
              <Label htmlFor="gc-codigo">Código de la giftcard</Label>
              <div className="flex gap-2">
                <Input
                  id="gc-codigo" placeholder="GC-XXXXXXXX" value={codigo}
                  className="font-mono uppercase"
                  onChange={(e) => setCodigo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleCanjear(); }}
                  autoFocus
                />
                <Button onClick={() => void handleCanjear()} disabled={canjeando}>
                  {canjeando ? 'Validando…' : 'Canjear'}
                </Button>
              </div>
              <p className="text-xs text-foreground/60">
                Un código solo se puede canjear UNA vez. Al canjear, aplicá el valor
                como descuento en el ticket (con código de manager).
              </p>
              {canje && (
                <div className="rounded-lg border border-green-300 bg-green-50 p-4 space-y-1">
                  <p className="font-medium text-green-900">✔ {canje.giftcard} — {formatARS(Number(canje.monto))}</p>
                  <p className="text-sm text-green-800">Comprada por {canje.comprador}{canje.para ? ` para ${canje.para}` : ''}</p>
                  {canje.mensaje && <p className="text-sm italic text-green-800">"{canje.mensaje}"</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Dialog evento ─────────────────────────────────────────────────── */}
      <Dialog open={evDialog} onOpenChange={(o) => !evSaving && setEvDialog(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{evEdit ? `Editar — ${evEdit.titulo}` : 'Nuevo evento'}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ev-titulo">Título *</Label>
              <Input id="ev-titulo" value={evForm.titulo} autoFocus placeholder="Cena Omakase 3er aniversario"
                     onChange={(e) => setEvForm((f) => ({ ...f, titulo: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ev-desc">Descripción</Label>
              <Textarea id="ev-desc" rows={2} value={evForm.descripcion}
                        onChange={(e) => setEvForm((f) => ({ ...f, descripcion: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ev-fecha">Fecha *</Label>
                <Input id="ev-fecha" type="date" value={evForm.fecha}
                       onChange={(e) => setEvForm((f) => ({ ...f, fecha: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ev-hora">Hora *</Label>
                <Input id="ev-hora" type="time" value={evForm.hora}
                       onChange={(e) => setEvForm((f) => ({ ...f, hora: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ev-precio">Precio por persona (ARS) *</Label>
                <Input id="ev-precio" type="number" min={0} value={evForm.precio}
                       onChange={(e) => setEvForm((f) => ({ ...f, precio: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ev-cupos">Cupos *</Label>
                <Input id="ev-cupos" type="number" min={1} value={evForm.cupos}
                       onChange={(e) => setEvForm((f) => ({ ...f, cupos: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ev-foto">Foto (URL)</Label>
              <Input id="ev-foto" value={evForm.fotoUrl} placeholder="https://…"
                     onChange={(e) => setEvForm((f) => ({ ...f, fotoUrl: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvDialog(false)} disabled={evSaving}>Cancelar</Button>
            <Button onClick={() => void guardarEvento()} disabled={evSaving}>
              {evSaving ? 'Guardando…' : evEdit ? 'Guardar cambios' : 'Crear (borrador)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog giftcard ───────────────────────────────────────────────── */}
      <Dialog open={gDialog} onOpenChange={(o) => !gSaving && setGDialog(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{gEdit ? `Editar — ${gEdit.nombre}` : 'Nueva giftcard'}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="g-nombre">Nombre *</Label>
              <Input id="g-nombre" value={gForm.nombre} autoFocus placeholder="Dinner Card para 2"
                     onChange={(e) => setGForm((f) => ({ ...f, nombre: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="g-desc">Descripción</Label>
              <Textarea id="g-desc" rows={2} value={gForm.descripcion}
                        placeholder="Cena para dos con entrada, roll para compartir y bebidas…"
                        onChange={(e) => setGForm((f) => ({ ...f, descripcion: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <div className="grid gap-1.5">
                <Label htmlFor="g-precio">Precio (ARS) *</Label>
                <Input id="g-precio" type="number" min={1} value={gForm.precio}
                       onChange={(e) => setGForm((f) => ({ ...f, precio: e.target.value }))} />
              </div>
              <label className="flex items-center gap-2 text-sm pb-2">
                <Switch checked={gForm.todoElGrupo}
                        onCheckedChange={(v) => setGForm((f) => ({ ...f, todoElGrupo: v }))} />
                Válida en todo el grupo
              </label>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="g-foto">Foto (URL)</Label>
              <Input id="g-foto" value={gForm.fotoUrl} placeholder="https://…"
                     onChange={(e) => setGForm((f) => ({ ...f, fotoUrl: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGDialog(false)} disabled={gSaving}>Cancelar</Button>
            <Button onClick={() => void guardarGift()} disabled={gSaving}>
              {gSaving ? 'Guardando…' : gEdit ? 'Guardar cambios' : 'Crear'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog inscriptos ─────────────────────────────────────────────── */}
      <Dialog open={!!inscDe} onOpenChange={(o) => !o && setInscDe(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Inscriptos — {inscDe?.titulo}</DialogTitle>
          </DialogHeader>
          {inscripciones.length === 0 ? (
            <p className="text-sm text-foreground/60 py-4">Todavía no hay inscripciones.</p>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {inscripciones.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 text-sm border-b border-border pb-1.5">
                  <div className="min-w-0">
                    <span className="font-medium">{i.nombre}</span>
                    <span className="text-foreground/60"> · {i.cantidad}p</span>
                    {i.telefono && <span className="text-foreground/60"> · {i.telefono}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span>{formatARS(Number(i.monto_total))}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      i.estado === 'pagada' ? 'bg-green-100 text-green-800' :
                      i.estado === 'pendiente_pago' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'
                    }`}>{i.estado.replace('_', ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
