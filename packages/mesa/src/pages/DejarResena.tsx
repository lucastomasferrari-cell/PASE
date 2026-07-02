// Reseña del cliente — /r/resena/:id.
// El cliente puntúa su experiencia; se verifica por teléfono y que la reserva
// haya asistido (sentada/finalizada). Una reseña por reserva.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Star, CheckCircle2 } from 'lucide-react';
import { supabaseConfigurado } from '@/lib/supabase';
import { crearReviewReserva } from '@/lib/perfilService';

export function DejarResena() {
  const { id } = useParams<{ id: string }>();
  const idNum = Number(id);
  const [telefono, setTelefono] = useState('');
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comentario, setComentario] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [hecho, setHecho] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) { setError('Elegí una puntuación (1 a 5 estrellas).'); return; }
    if (!telefono.trim()) { setError('Ingresá el teléfono con el que reservaste.'); return; }
    setEnviando(true); setError(null);
    const r = await crearReviewReserva({ reservaId: idNum, telefono, rating, comentario });
    setEnviando(false);
    if (r.error) {
      const m = r.error;
      if (m.includes('TELEFONO_NO_COINCIDE')) setError('Ese teléfono no coincide con la reserva.');
      else if (m.includes('RESERVA_NO_ELEGIBLE')) setError('Esta reserva todavía no figura como visitada.');
      else if (m.includes('RESERVA_NO_ENCONTRADA')) setError('No encontramos la reserva.');
      else setError('No se pudo enviar la reseña. Probá de nuevo.');
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
        <p className="mt-4 text-2xl font-medium">¡Gracias por tu reseña!</p>
        <p className="mt-1 text-sm text-ink-muted">Tu opinión nos ayuda un montón.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-brand-600 hover:underline">← Volver</Link>
      </Centro>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <form onSubmit={enviar} className="w-full max-w-md rounded-2xl bg-white border border-ink/5 shadow-card p-8">
        <p className="text-2xl font-medium text-center">¿Cómo estuvo tu experiencia?</p>
        <p className="mt-1 text-sm text-ink-muted text-center">Contanos qué te pareció.</p>

        <div className="mt-6 flex justify-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-label={`${n} estrellas`}
                    onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
                    onClick={() => setRating(n)}>
              <Star className={`h-9 w-9 transition-colors ${(hover || rating) >= n ? 'fill-amber-400 text-amber-400' : 'text-ink/20'}`} />
            </button>
          ))}
        </div>

        <label htmlFor="com" className="mt-6 block text-xs uppercase tracking-widest text-ink-muted">Comentario (opcional)</label>
        <textarea id="com" value={comentario} onChange={(e) => setComentario(e.target.value)} rows={3}
                  className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Lo que quieras contarnos…" />

        <label htmlFor="tel" className="mt-4 block text-xs uppercase tracking-widest text-ink-muted">Teléfono de la reserva</label>
        <input id="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
               className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Ej: 11 5933 3093" />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={enviando}
                className="mt-6 w-full rounded-lg bg-ink text-white py-3 text-sm font-medium disabled:opacity-50">
          {enviando ? 'Enviando…' : 'Enviar reseña'}
        </button>
      </form>
    </div>
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-center px-6"><div>{children}</div></div>;
}
