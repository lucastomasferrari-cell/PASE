// ReservasAdmin — pantalla para gestionar reservas online.
//
// Tabs:
//   - Hoy/Próximas: lo importante para operar el día.
//   - Pendientes confirmación: si el local requiere confirmación manual.
//   - Histórico: todas con filtros.
//
// Acciones por reserva:
//   - Confirmar (si está pendiente)
//   - Marcar cumplida (cuando el cliente vino y consumió)
//   - Marcar no-show (no apareció)
//   - Cancelar con motivo
//   - WhatsApp directo al cliente

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarCheck, Phone, MessageCircle, Check, X,
  Clock, Users, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  listReservas, cambiarEstadoReserva, type Reserva, type EstadoReserva,
} from '@/services/reservasService';
import { whatsAppUrl, mensajeGenericoCliente } from '@/lib/whatsapp';

const ESTADO_COLORS: Record<EstadoReserva, string> = {
  pendiente:  'bg-amber-100 text-amber-800',
  confirmada: 'bg-green-100 text-green-800',
  cumplida:   'bg-sky-100 text-sky-800',
  no_show:    'bg-red-100 text-red-800',
  cancelada:  'bg-gray-100 text-gray-700',
};

const ESTADO_LABELS: Record<EstadoReserva, string> = {
  pendiente:  '⏳ Pendiente',
  confirmada: '✓ Confirmada',
  cumplida:   '✅ Cumplida',
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

export function ReservasAdmin() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [reservas, setReservas] = useState<Reserva[]>([]);
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

  const now = Date.now();
  const grupos = useMemo(() => {
    return {
      pendientes: reservas.filter((r) => r.estado === 'pendiente'),
      proximas: reservas.filter((r) =>
        r.estado === 'confirmada' && new Date(r.fecha_hora).getTime() > now - 3600_000
      ).sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)),
      historico: reservas.filter((r) =>
        r.estado === 'cumplida' || r.estado === 'no_show' || r.estado === 'cancelada' ||
        (r.estado === 'confirmada' && new Date(r.fecha_hora).getTime() <= now - 3600_000)
      ).sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora)),
    };
  }, [reservas, now]);

  async function cambiarEstado(r: Reserva, nuevoEstado: 'confirmada' | 'cumplida' | 'no_show' | 'cancelada', motivo?: string) {
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
  async function handleCumplida(r: Reserva) { await cambiarEstado(r, 'cumplida'); }
  async function handleNoShow(r: Reserva) {
    if (!confirm(`Marcar reserva #${r.id} (${r.cliente_nombre}) como NO SHOW?`)) return;
    await cambiarEstado(r, 'no_show');
  }
  async function handleCancelar(r: Reserva) {
    const motivo = prompt('Motivo de cancelación (opcional):');
    if (motivo === null) return; // canceló el prompt
    await cambiarEstado(r, 'cancelada', motivo || undefined);
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
        <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <Tabs defaultValue="pendientes" className="w-full">
        <TabsList>
          <TabsTrigger value="pendientes">
            Pendientes confirmación {grupos.pendientes.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-xs">
                {grupos.pendientes.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="proximas">Próximas ({grupos.proximas.length})</TabsTrigger>
          <TabsTrigger value="historico">Histórico ({grupos.historico.length})</TabsTrigger>
        </TabsList>

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
                        onConfirmar={() => handleConfirmar(r)}
                        onCancelar={() => handleCancelar(r)} />
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
                        onCumplida={() => handleCumplida(r)}
                        onNoShow={() => handleNoShow(r)}
                        onCancelar={() => handleCancelar(r)} />
          ))}
        </TabsContent>

        <TabsContent value="historico" className="mt-4 space-y-2">
          {grupos.historico.map((r) => (
            <ReservaRow key={r.id} reserva={r} readOnly />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReservaRow({
  reserva: r, busy, onConfirmar, onCumplida, onNoShow, onCancelar, readOnly,
}: {
  reserva: Reserva;
  busy?: boolean;
  onConfirmar?: () => void;
  onCumplida?: () => void;
  onNoShow?: () => void;
  onCancelar?: () => void;
  readOnly?: boolean;
}) {
  const wpUrl = whatsAppUrl(r.cliente_telefono, mensajeGenericoCliente(r.cliente_nombre, r.id));
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
              <span className="text-xs text-foreground/60">#{r.id}</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-foreground/70 mt-1">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> {fmtFechaCorta(r.fecha_hora)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {r.personas}
              </span>
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
          </div>

          {!readOnly && (
            <div className="flex gap-1.5 shrink-0">
              {onConfirmar && (
                <Button size="sm" onClick={onConfirmar} disabled={busy}>
                  <Check className="h-4 w-4 mr-1" /> Confirmar
                </Button>
              )}
              {onCumplida && (
                <Button size="sm" variant="outline" onClick={onCumplida} disabled={busy}>
                  Cumplida
                </Button>
              )}
              {onNoShow && (
                <Button size="sm" variant="outline" onClick={onNoShow} disabled={busy} className="text-red-700 hover:bg-red-50">
                  No show
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
