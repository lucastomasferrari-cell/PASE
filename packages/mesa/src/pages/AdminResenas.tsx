// Reseñas — sección del panel MESA. Rating global + por aspecto (comida /
// presentación / entrega) + lista de reseñas. Lee fn_listar_reviews_publicas.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Star, MessageSquare } from 'lucide-react';
import { listarReviews, type Review } from '@/lib/reviewsService';

interface Props { localSlug: string | null; }

function fechaCorta(iso: string) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' });
}
function prom(vals: (number | null | undefined)[]): number | null {
  const ns = vals.filter((v): v is number => typeof v === 'number' && v > 0);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

export function AdminResenas({ localSlug }: Props) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ratingProm, setRatingProm] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    if (!localSlug) { setCargando(false); return; }
    setCargando(true);
    const { data, error } = await listarReviews(localSlug);
    if (error) toast.error('No se pudieron cargar las reseñas: ' + error);
    setReviews(data.reviews);
    setRatingProm(data.rating_promedio);
    setTotal(data.total_reviews);
    setCargando(false);
  }, [localSlug]);

  useEffect(() => { void reload(); }, [reload]);

  const aspectos = [
    { label: 'Comida', val: prom(reviews.map((r) => r.estrellas_comida)) },
    { label: 'Presentación', val: prom(reviews.map((r) => r.estrellas_presentacion)) },
    { label: 'Entrega', val: prom(reviews.map((r) => r.estrellas_entrega)) },
  ].filter((a) => a.val != null);

  if (!localSlug) {
    return <div className="mt-6 rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center text-ink-muted">Este local no tiene página pública configurada todavía.</div>;
  }
  if (cargando) return <div className="mt-6 py-16 text-center text-ink-muted">Cargando reseñas…</div>;

  return (
    <div className="mt-6 space-y-5 max-w-3xl">
      {/* Resumen */}
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <div className="text-4xl font-semibold text-ink">{ratingProm != null ? ratingProm.toFixed(1) : '—'}</div>
            <Estrellas n={Math.round(ratingProm ?? 0)} />
            <div className="text-xs text-ink-muted mt-1">{total} reseña{total !== 1 ? 's' : ''}</div>
          </div>
          {aspectos.length > 0 && (
            <div className="flex-1 min-w-[200px] grid sm:grid-cols-3 gap-3">
              {aspectos.map((a) => (
                <div key={a.label}>
                  <div className="text-xs text-ink-muted">{a.label}</div>
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-semibold text-ink">{a.val!.toFixed(1)}</span>
                    <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lista */}
      {reviews.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3">
            <MessageSquare className="h-7 w-7" />
          </div>
          <p className="font-medium">Todavía no hay reseñas</p>
          <p className="text-sm text-ink-muted mt-1">Cuando tus clientes dejen reseñas, aparecen acá.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reviews.map((r) => (
            <div key={r.review_id} className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm">
                    {(r.autor_nombre[0] ?? '?').toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{r.autor_nombre}</div>
                    <Estrellas n={r.rating} />
                  </div>
                </div>
                <span className="text-xs text-ink-muted">{fechaCorta(r.created_at)}</span>
              </div>
              {r.comentario && <p className="text-sm text-ink-soft mt-2">{r.comentario}</p>}
              {r.foto_url && <img src={r.foto_url} alt="foto reseña" className="mt-2 rounded-lg max-h-40 object-cover" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Estrellas({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-3.5 w-3.5 ${i <= n ? 'text-amber-400 fill-amber-400' : 'text-ink/15'}`} />
      ))}
    </span>
  );
}
