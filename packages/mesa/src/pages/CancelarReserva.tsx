// Autocancelación por el cliente — /r/cancelar/:id.
// El cliente confirma con su teléfono (misma verificación que el RPC público).
// No expone datos de la reserva por id: si el teléfono coincide, la cancela.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CalendarX, CheckCircle2 } from 'lucide-react';
import { supabaseConfigurado } from '@/lib/supabase';
import { cancelarReservaPublica } from '@/lib/perfilService';

export function CancelarReserva() {
  const { id } = useParams<{ id: string }>();
  const idNum = Number(id);
  const [telefono, setTelefono] = useState('');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [hecho, setHecho] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelar(e: React.FormEvent) {
    e.preventDefault();
    if (!telefono.trim()) { setError('Ingresá el teléfono con el que reservaste.'); return; }
    setEnviando(true); setError(null);
    const r = await cancelarReservaPublica(idNum, telefono, motivo);
    setEnviando(false);
    if (r.error) { setError('No se pudo cancelar. Probá de nuevo en un momento.'); return; }
    if (!r.ok) { setError('No encontramos una reserva activa con ese teléfono. Revisá el número o escribinos.'); return; }
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

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <form onSubmit={cancelar} className="w-full max-w-md rounded-2xl bg-white border border-ink/5 shadow-card p-8">
        <CalendarX className="h-10 w-10 text-ink mx-auto" />
        <p className="mt-4 text-2xl font-medium text-center">Cancelar mi reserva</p>
        <p className="mt-1 text-sm text-ink-muted text-center">Confirmá con el teléfono con el que reservaste.</p>

        <label htmlFor="tel" className="mt-6 block text-xs uppercase tracking-widest text-ink-muted">Teléfono</label>
        <input id="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
               className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Ej: 11 5933 3093" />

        <label htmlFor="mot" className="mt-4 block text-xs uppercase tracking-widest text-ink-muted">Motivo (opcional)</label>
        <input id="mot" value={motivo} onChange={(e) => setMotivo(e.target.value)}
               className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={enviando}
                className="mt-6 w-full rounded-lg bg-ink text-white py-3 text-sm font-medium disabled:opacity-50">
          {enviando ? 'Cancelando…' : 'Cancelar reserva'}
        </button>
        <Link to="/" className="mt-4 block text-center text-sm text-ink-muted hover:underline">Mejor no, volver</Link>
      </form>
    </div>
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-center px-6"><div>{children}</div></div>;
}
