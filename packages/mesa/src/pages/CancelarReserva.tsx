// Autocancelación por el cliente — /r/cancelar/:id?t=<token>.
// Con token (link del mail/confirmación): muestra la reserva, pide motivo y
// confirma — sin pedir teléfono. Sin token: fallback que verifica por teléfono.

import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CalendarX, CheckCircle2, Loader2 } from 'lucide-react';
import { supabaseConfigurado } from '@/lib/supabase';
import {
  cancelarReservaPublica, cancelarReservaPorToken, getReservaResumen, type ReservaResumen,
} from '@/lib/perfilService';

function fmt(iso: string) {
  return new Date(iso).toLocaleString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

export function CancelarReserva() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const token = params.get('t');
  const idNum = Number(id);

  const [telefono, setTelefono] = useState('');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [hecho, setHecho] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modo token: cargar el resumen de la reserva.
  const [resumen, setResumen] = useState<ReservaResumen | null>(null);
  const [cargando, setCargando] = useState(Boolean(token));
  useEffect(() => {
    if (!token || !idNum) return;
    let vivo = true;
    void getReservaResumen(idNum, token).then((r) => {
      if (!vivo) return;
      setResumen(r);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [token, idNum]);

  async function cancelar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true); setError(null);
    const r = token
      ? await cancelarReservaPorToken(idNum, token, motivo)
      : (telefono.trim()
          ? await cancelarReservaPublica(idNum, telefono, motivo)
          : { ok: false, error: 'FALTA_TEL' });
    setEnviando(false);
    if (!token && (r as { error?: string }).error === 'FALTA_TEL') { setError('Ingresá el teléfono con el que reservaste.'); return; }
    if (r.error) { setError('No se pudo cancelar. Probá de nuevo en un momento.'); return; }
    if (!r.ok) {
      setError(token
        ? 'Esta reserva ya no se puede cancelar (quizás ya estaba cancelada).'
        : 'No encontramos una reserva activa con ese teléfono. Revisá el número o escribinos.');
      return;
    }
    setHecho(true);
  }

  if (!supabaseConfigurado || !idNum) {
    return <Centro><p className="text-2xl">Link inválido</p></Centro>;
  }
  if (hecho) {
    return (
      <Centro>
        <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
        <p className="mt-4 text-2xl font-medium">Reserva cancelada</p>
        <p className="mt-1 text-sm text-ink-muted">Listo, liberamos tu mesa. ¡Te esperamos otro día!</p>
        <Link to="/" className="mt-6 inline-block text-sm text-brand-600 hover:underline">← Volver</Link>
      </Centro>
    );
  }
  if (token && cargando) {
    return <Centro><Loader2 className="h-8 w-8 animate-spin text-ink-muted mx-auto" /></Centro>;
  }
  // Con token pero la reserva no existe / token inválido.
  if (token && !resumen) {
    return <Centro><p className="text-2xl">No encontramos esta reserva</p><p className="mt-2 text-sm text-ink-muted">El link puede estar vencido o ser incorrecto.</p></Centro>;
  }
  // Reserva ya no cancelable (finalizada/cancelada/no_show).
  if (token && resumen && !resumen.cancelable) {
    return (
      <Centro>
        <p className="text-2xl font-medium">{resumen.estado === 'cancelada' ? 'Esta reserva ya estaba cancelada' : 'Esta reserva ya no se puede cancelar'}</p>
        <p className="mt-2 text-sm text-ink-muted">Cualquier duda, escribinos.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-brand-600 hover:underline">← Volver</Link>
      </Centro>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <form onSubmit={cancelar} className="w-full max-w-md rounded-2xl bg-white border border-ink/5 shadow-card p-8">
        <CalendarX className="h-10 w-10 text-ink mx-auto" />
        <p className="mt-4 text-2xl font-medium text-center">Cancelar mi reserva</p>

        {token && resumen ? (
          <div className="mt-4 rounded-xl bg-crema p-4 text-sm text-center">
            <p className="font-medium">{resumen.local_nombre}</p>
            <p className="text-ink-soft mt-0.5">{fmt(resumen.fecha_hora)}</p>
            <p className="text-ink-soft">{resumen.personas} {resumen.personas === 1 ? 'persona' : 'personas'} · a nombre de {resumen.cliente_nombre}</p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted text-center">Confirmá con el teléfono con el que reservaste.</p>
        )}

        {!token && (
          <>
            <label htmlFor="tel" className="mt-6 block text-xs uppercase tracking-widest text-ink-muted">Teléfono</label>
            <input id="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
                   className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Ej: 11 5933 3093" />
          </>
        )}

        <label htmlFor="mot" className="mt-4 block text-xs uppercase tracking-widest text-ink-muted">Motivo (opcional)</label>
        <input id="mot" value={motivo} onChange={(e) => setMotivo(e.target.value)}
               className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Ej: me surgió un imprevisto" />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={enviando}
                className="mt-6 w-full rounded-lg bg-ink text-white py-3 text-sm font-medium disabled:opacity-50">
          {enviando ? 'Cancelando…' : 'Confirmar cancelación'}
        </button>
        <Link to="/" className="mt-4 block text-center text-sm text-ink-muted hover:underline">Mejor no, volver</Link>
      </form>
    </div>
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-center px-6"><div>{children}</div></div>;
}
