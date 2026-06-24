import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Phone, Users, Clock, MessageCircle, Armchair, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  listWaitlistActiva,
  agregarWaitlist,
  llamarWaitlist,
  sentarWaitlist,
  cancelarWaitlist,
  type WaitlistEntry,
} from '@/services/waitlistService';
import { whatsAppUrl, mensajeHayMesaWaitlist } from '@/lib/whatsapp';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

function minutosEnCola(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'ahora';
  if (min === 1) return '1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

interface FormState {
  nombre: string;
  telefono: string;
  personas: string;
  notas: string;
}

const FORM_VACIO: FormState = { nombre: '', telefono: '', personas: '2', notas: '' };

interface Props {
  localId: number;
  localNombre: string;
}

export function WaitlistTab({ localId, localNombre }: Props) {
  const { user } = useAuth();
  const [lista, setLista] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(FORM_VACIO);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const { data } = await listWaitlistActiva(localId);
    setLista(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);

  async function guardarNuevo() {
    if (!form.nombre.trim()) { toast.error('Nombre obligatorio'); return; }
    const personas = parseInt(form.personas, 10);
    if (!personas || personas < 1) { toast.error('Personas inválido'); return; }
    if (!user?.tenant_id) { toast.error('Sin tenant'); return; }
    setSaving(true);
    const { error } = await agregarWaitlist(user.tenant_id, localId, {
      clienteNombre: form.nombre.trim(),
      clienteTelefono: form.telefono.trim() || undefined,
      personas,
      notas: form.notas.trim() || undefined,
    });
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Agregado a la lista de espera');
    setForm(FORM_VACIO);
    setFormOpen(false);
    void reload();
  }

  async function handleLlamar(entry: WaitlistEntry) {
    setBusy(entry.id);
    await llamarWaitlist(entry.id);
    setBusy(null);
    const waUrl = entry.cliente_telefono
      ? whatsAppUrl(entry.cliente_telefono, mensajeHayMesaWaitlist({ clienteNombre: entry.cliente_nombre, localNombre, personas: entry.personas }))
      : null;
    if (waUrl) {
      toast.success(`${entry.cliente_nombre} marcado como llamado`, {
        action: { label: '📲 Enviar WA', onClick: () => window.open(waUrl, '_blank') },
        duration: 10_000,
      });
    } else {
      toast.success(`${entry.cliente_nombre} marcado como llamado`);
    }
    void reload();
  }

  async function handleSentar(entry: WaitlistEntry) {
    setBusy(entry.id);
    await sentarWaitlist(entry.id);
    setBusy(null);
    toast.success(`${entry.cliente_nombre} sentado`);
    void reload();
  }

  async function handleCancelar(entry: WaitlistEntry) {
    setBusy(entry.id);
    await cancelarWaitlist(entry.id);
    setBusy(null);
    void reload();
  }

  const esperando = lista.filter((e) => e.estado === 'esperando');
  const llamados  = lista.filter((e) => e.estado === 'llamado');

  if (loading) return <p className="py-12 text-center text-muted-foreground text-sm">Cargando…</p>;

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-base">Lista de espera</h3>
          {lista.length > 0 && (
            <Badge className="bg-orange-100 text-orange-800 border-orange-300">
              {lista.length} {lista.length === 1 ? 'grupo' : 'grupos'}
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => setFormOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Agregar
        </Button>
      </div>

      {/* Formulario inline */}
      {formOpen && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium">Nuevo grupo en espera</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 grid gap-1">
                <Label htmlFor="wl-nombre">Nombre *</Label>
                <Input id="wl-nombre" placeholder="García" value={form.nombre}
                       onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
                       onKeyDown={(e) => e.key === 'Enter' && void guardarNuevo()} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="wl-tel">Teléfono</Label>
                <Input id="wl-tel" placeholder="11 xxxx-xxxx" value={form.telefono}
                       onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="wl-pers">Personas *</Label>
                <Input id="wl-pers" type="number" min={1} max={30} value={form.personas}
                       onChange={(e) => setForm((f) => ({ ...f, personas: e.target.value }))} />
              </div>
              <div className="col-span-2 grid gap-1">
                <Label htmlFor="wl-notas">Nota (opcional)</Label>
                <Input id="wl-notas" placeholder="Cumpleaños, silla bebé…" value={form.notas}
                       onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setFormOpen(false); setForm(FORM_VACIO); }}>
                Cancelar
              </Button>
              <Button size="sm" onClick={() => void guardarNuevo()} disabled={saving}>
                {saving ? 'Guardando…' : 'Agregar a la lista'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sección: Llamados (hay mesa disponible) */}
      {llamados.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1.5">
            <span className="animate-pulse">🔔</span> Llamados — esperando que bajen
          </p>
          {llamados.map((e) => (
            <WaitlistCard key={e.id} entry={e} busy={busy === e.id}
                          onSentar={() => void handleSentar(e)}
                          onCancelar={() => void handleCancelar(e)}
                          localNombre={localNombre} />
          ))}
        </div>
      )}

      {/* Sección: En espera */}
      {esperando.length === 0 && llamados.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Clock className="h-8 w-8 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No hay nadie en lista de espera.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Cuando llegue alguien sin reserva, agregalo con el botón de arriba.
            </p>
          </CardContent>
        </Card>
      ) : (
        esperando.length > 0 && (
          <div className="space-y-2">
            {llamados.length > 0 && (
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                En espera
              </p>
            )}
            {esperando.map((e, idx) => (
              <WaitlistCard key={e.id} entry={e} busy={busy === e.id} posicion={idx + 1}
                            onLlamar={() => void handleLlamar(e)}
                            onCancelar={() => void handleCancelar(e)}
                            localNombre={localNombre} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function WaitlistCard({
  entry: e, busy, posicion, onLlamar, onSentar, onCancelar, localNombre,
}: {
  entry: WaitlistEntry;
  busy: boolean;
  posicion?: number;
  onLlamar?: () => void;
  onSentar?: () => void;
  onCancelar?: () => void;
  localNombre: string;
}) {
  const waUrl = e.cliente_telefono
    ? whatsAppUrl(e.cliente_telefono, mensajeHayMesaWaitlist({ clienteNombre: e.cliente_nombre, localNombre, personas: e.personas }))
    : null;

  const isLlamado = e.estado === 'llamado';

  return (
    <Card className={cn(isLlamado && 'border-amber-400 bg-amber-50/50')}>
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Posición en cola */}
            {posicion && (
              <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                {posicion}
              </div>
            )}
            {isLlamado && (
              <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center text-base leading-none">
                🔔
              </div>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{e.cliente_nombre}</span>
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Users className="h-3.5 w-3.5" /> {e.personas}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" /> {minutosEnCola(e.created_at)}
                </span>
                {isLlamado && e.llamado_at && (
                  <span className="text-xs text-amber-700">
                    llamado hace {minutosEnCola(e.llamado_at)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                {e.cliente_telefono && (
                  <a href={`tel:${e.cliente_telefono}`}
                     className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground hover:underline">
                    <Phone className="h-3 w-3" /> {e.cliente_telefono}
                  </a>
                )}
                {waUrl && (
                  <a href={waUrl} target="_blank" rel="noopener"
                     className="text-xs text-green-700 flex items-center gap-1 hover:underline">
                    <MessageCircle className="h-3 w-3" /> WA
                  </a>
                )}
              </div>
              {e.notas && (
                <p className="text-xs text-muted-foreground italic mt-0.5">"{e.notas}"</p>
              )}
            </div>
          </div>

          {/* Acciones */}
          <div className="flex items-center gap-1.5 shrink-0">
            {!isLlamado && onLlamar && (
              <Button size="sm" variant="outline"
                      className="border-amber-400 text-amber-800 hover:bg-amber-50 gap-1 text-xs h-8"
                      onClick={onLlamar} disabled={busy}>
                🔔 Llamar
              </Button>
            )}
            {isLlamado && onSentar && (
              <Button size="sm"
                      className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1 text-xs h-8"
                      onClick={onSentar} disabled={busy}>
                <Armchair className="h-3.5 w-3.5" /> Sentar
              </Button>
            )}
            {onCancelar && (
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      onClick={onCancelar} disabled={busy} title="Quitar de la lista">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
