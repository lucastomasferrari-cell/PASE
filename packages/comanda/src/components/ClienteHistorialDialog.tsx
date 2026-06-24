import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Star, Phone, Mail, Users, CalendarCheck, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { getCliente, updateCliente } from '@/services/clientesService';
import { listReservasByCliente, type Reserva } from '@/services/reservasService';
import type { Cliente } from '@/types/database';
import { cn } from '@/lib/utils';

function fmtFechaCorta(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

const ESTADO_ICON: Record<Reserva['estado'], string> = {
  pendiente:    '⏳',
  confirmada:   '✅',
  sentada:      '🪑',
  finalizada:   '✅',
  no_show:      '⚠️',
  cancelada:    '❌',
};

const ESTADO_CLASS: Record<Reserva['estado'], string> = {
  pendiente:    'text-amber-600',
  confirmada:   'text-blue-600',
  sentada:      'text-indigo-600',
  finalizada:   'text-emerald-600',
  no_show:      'text-red-600',
  cancelada:    'text-muted-foreground line-through',
};

interface Props {
  clienteId: number | null;
  onClose: () => void;
}

export function ClienteHistorialDialog({ clienteId, onClose }: Props) {
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [loading, setLoading] = useState(false);
  const [notas, setNotas] = useState('');
  const [savingNotas, setSavingNotas] = useState(false);
  const [togglingVip, setTogglingVip] = useState(false);

  useEffect(() => {
    if (!clienteId) return;
    setLoading(true);
    void Promise.all([
      getCliente(clienteId),
      listReservasByCliente(clienteId),
    ]).then(([cli, res]) => {
      setCliente(cli.data);
      setNotas(cli.data?.notas ?? '');
      setReservas(res.data);
      setLoading(false);
    });
  }, [clienteId]);

  async function guardarNotas() {
    if (!cliente) return;
    setSavingNotas(true);
    const { error } = await updateCliente(cliente.id, { notas: notas.trim() || null });
    setSavingNotas(false);
    if (error) toast.error('Error guardando notas: ' + error);
    else {
      toast.success('Notas guardadas');
      setCliente((c) => c ? { ...c, notas: notas.trim() || null } : c);
    }
  }

  async function toggleVip() {
    if (!cliente) return;
    setTogglingVip(true);
    const nuevoVip = !cliente.vip;
    const { error } = await updateCliente(cliente.id, { vip: nuevoVip });
    setTogglingVip(false);
    if (error) toast.error('Error: ' + error);
    else setCliente((c) => c ? { ...c, vip: nuevoVip } : c);
  }

  // Estadísticas
  const stats = {
    total: reservas.length,
    noShows: reservas.filter((r) => r.estado === 'no_show').length,
    canceladas: reservas.filter((r) => r.estado === 'cancelada').length,
    completadas: reservas.filter((r) => r.estado === 'finalizada' || r.estado === 'sentada').length,
  };
  const tasaNoShow = stats.total > 0 ? Math.round((stats.noShows / stats.total) * 100) : 0;

  return (
    <Dialog open={clienteId !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            {loading ? (
              <span className="text-muted-foreground">Cargando…</span>
            ) : (
              <>
                <span>{cliente?.nombre ?? 'Cliente'}{cliente?.apellido ? ` ${cliente.apellido}` : ''}</span>
                {cliente?.vip && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-300 gap-1">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> VIP
                  </Badge>
                )}
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        {!loading && cliente && (
          <div className="space-y-5">
            {/* Info de contacto */}
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              {cliente.telefono && (
                <a href={`tel:${cliente.telefono}`} className="flex items-center gap-1.5 hover:text-foreground hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {cliente.telefono}
                </a>
              )}
              {cliente.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> {cliente.email}
                </span>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{stats.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">reservas</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className={cn('text-2xl font-bold', tasaNoShow > 25 ? 'text-red-600' : tasaNoShow > 10 ? 'text-amber-600' : 'text-foreground')}>
                  {tasaNoShow}%
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">no-shows</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-emerald-600">{stats.completadas}</p>
                <p className="text-xs text-muted-foreground mt-0.5">completadas</p>
              </div>
            </div>

            {/* Historial de reservas */}
            {reservas.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Historial de reservas
                </p>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {reservas.map((r) => (
                    <div key={r.id} className="flex items-center gap-2.5 text-sm py-1 border-b border-border/50 last:border-0">
                      <span className="text-base leading-none">{ESTADO_ICON[r.estado]}</span>
                      <span className={cn('flex-1 min-w-0 truncate', ESTADO_CLASS[r.estado])}>
                        {fmtFechaCorta(r.fecha_hora)}
                      </span>
                      <span className="flex items-center gap-1 text-muted-foreground shrink-0">
                        <Users className="h-3.5 w-3.5" /> {r.personas}
                      </span>
                      {r.notas && (
                        <span className="text-xs text-muted-foreground italic truncate max-w-[120px]" title={r.notas}>
                          "{r.notas}"
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reservas.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Primera reserva de este cliente.
              </p>
            )}

            {/* Notas */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Notas internas
              </p>
              <Textarea
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                rows={3}
                placeholder="Alergias, preferencias, datos especiales…"
                className="text-sm resize-none"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void toggleVip()}
                  disabled={togglingVip}
                  className={cn(
                    'gap-1.5',
                    cliente.vip && 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
                  )}
                >
                  <Star className={cn('h-3.5 w-3.5', cliente.vip && 'fill-amber-500 text-amber-500')} />
                  {cliente.vip ? 'Quitar VIP' : 'Marcar VIP'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void guardarNotas()}
                  disabled={savingNotas || notas === (cliente.notas ?? '')}
                >
                  {savingNotas ? 'Guardando…' : <><Check className="h-3.5 w-3.5 mr-1" />Guardar notas</>}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!loading && !cliente && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            <CalendarCheck className="h-8 w-8 mx-auto mb-2" />
            Este cliente no tiene perfil creado todavía.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
