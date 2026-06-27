// Recordatorios — reservas confirmadas que arrancan pronto, para avisarles por
// WhatsApp antes de que vengan. Click-to-chat (wa.me) + marcar enviado.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircle, Check, Clock, Users, BellRing } from 'lucide-react';
import { listReservasParaRecordatorio, marcarRecordatorioEnviado, type Reserva } from '@/lib/reservasService';
import { whatsAppUrl, mensajeRecordatorioReserva } from '@/lib/whatsapp';

interface Props { localId: number; localNombre: string; }

function hhmm(iso: string) { return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); }
function enCuanto(iso: string) {
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return 'ahora';
  if (min < 60) return `en ${min} min`;
  return `en ${Math.floor(min / 60)}h ${min % 60}m`;
}

export function AdminRecordatorios({ localId, localNombre }: Props) {
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listReservasParaRecordatorio(localId, 4);
    if (error) toast.error('No se pudieron cargar: ' + error);
    setReservas(data);
    setCargando(false);
  }, [localId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 120000);
    return () => clearInterval(id);
  }, [reload]);

  async function marcar(r: Reserva) {
    setReservas((prev) => prev.filter((x) => x.id !== r.id));
    const { error } = await marcarRecordatorioEnviado(r.id);
    if (error) { toast.error(error); void reload(); }
  }

  return (
    <div className="mt-6 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <BellRing className="h-4 w-4 text-brand-500" />
        Reservas confirmadas que empiezan en las próximas 4 horas y todavía no recibieron recordatorio.
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : reservas.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
          <p className="font-medium">Nada por recordar ahora</p>
          <p className="text-sm text-ink-muted mt-1">Cuando se acerque la hora de una reserva confirmada, aparece acá.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reservas.map((r) => {
            const waUrl = r.cliente_telefono
              ? whatsAppUrl(r.cliente_telefono, mensajeRecordatorioReserva({ clienteNombre: r.cliente_nombre, localNombre, fechaHora: r.fecha_hora, personas: r.personas }))
              : null;
            return (
              <div key={r.id} className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 flex items-center gap-3 flex-wrap">
                <div className="text-center min-w-[54px]">
                  <div className="text-lg font-medium tabular-nums">{hhmm(r.fecha_hora)}</div>
                  <div className="text-[11px] text-brand-600 inline-flex items-center gap-0.5"><Clock className="h-3 w-3" />{enCuanto(r.fecha_hora)}</div>
                </div>
                <div className="flex-1 min-w-[140px]">
                  <div className="font-medium">{r.cliente_nombre}</div>
                  <div className="text-xs text-ink-muted flex items-center gap-2">
                    <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{r.personas}</span>
                    {r.cliente_telefono && <span>· {r.cliente_telefono}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {waUrl ? (
                    <a href={waUrl} target="_blank" rel="noopener noreferrer"
                       className="text-sm px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-medium inline-flex items-center gap-1.5">
                      <MessageCircle className="h-4 w-4" /> Recordar
                    </a>
                  ) : (
                    <span className="text-xs text-ink-muted">Sin teléfono</span>
                  )}
                  <button onClick={() => void marcar(r)} title="Marcar como avisado"
                          className="text-sm px-3 py-2 rounded-lg border border-ink/15 bg-white hover:bg-ink/5 text-ink-soft font-medium inline-flex items-center gap-1.5">
                    <Check className="h-4 w-4" /> Listo
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
