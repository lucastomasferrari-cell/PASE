// Calidad — control de calidad / reputación. Reúne las reseñas internas (de los
// pedidos del marketplace/web y de las visitas), alerta las bajas, y te deja
// pedir reseñas de Google Maps por WhatsApp. La traída automática de reseñas de
// Google Maps es una integración (Places API) que queda cableada.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Star, AlertTriangle, MessageSquare, MapPin, MessageCircle, Copy } from 'lucide-react';
import { listLocales, type LocalLite } from '@/lib/localesService';
import { listarReviews, type Review } from '@/lib/reviewsService';

function fechaCorta(iso: string) { return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' }); }
function prom(vals: (number | null | undefined)[]): number | null {
  const ns = vals.filter((v): v is number => typeof v === 'number' && v > 0);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

export function Calidad() {
  const [locales, setLocales] = useState<LocalLite[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ratingProm, setRatingProm] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    void listLocales().then((r) => {
      setLocales(r.data);
      if (r.data.length > 0) setSel(r.data[0]!.settings_id);
      if (r.data.length === 0) setCargando(false);
    });
  }, []);

  const localSel = locales.find((l) => l.settings_id === sel) ?? null;

  const reload = useCallback(async (slug: string | null) => {
    setCargando(true);
    const { data } = await listarReviews(slug);
    setReviews(data.reviews); setRatingProm(data.rating_promedio); setTotal(data.total_reviews);
    setCargando(false);
  }, []);

  useEffect(() => { if (localSel) void reload(localSel.slug); }, [localSel, reload]);

  const aspectos = [
    { label: 'Comida', val: prom(reviews.map((r) => r.estrellas_comida)) },
    { label: 'Presentación', val: prom(reviews.map((r) => r.estrellas_presentacion)) },
    { label: 'Entrega', val: prom(reviews.map((r) => r.estrellas_entrega)) },
  ].filter((a) => a.val != null);

  const bajas = useMemo(() => reviews.filter((r) => r.rating <= 3), [reviews]);

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Selector de local */}
      {locales.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {locales.map((l) => (
            <button key={l.settings_id} onClick={() => setSel(l.settings_id)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-medium border ${sel === l.settings_id ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'}`}>
              {l.nombre}
            </button>
          ))}
        </div>
      )}

      {/* Resumen */}
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <div className="text-4xl font-semibold text-ink">{ratingProm != null ? ratingProm.toFixed(1) : '—'}</div>
            <Estrellas n={Math.round(ratingProm ?? 0)} />
            <div className="text-xs text-ink-muted mt-1">{total} reseña{total !== 1 ? 's' : ''} internas</div>
          </div>
          {aspectos.length > 0 && (
            <div className="flex-1 min-w-[200px] grid sm:grid-cols-3 gap-3">
              {aspectos.map((a) => (
                <div key={a.label}>
                  <div className="text-xs text-ink-muted">{a.label}</div>
                  <div className="flex items-center gap-1"><span className="text-sm font-semibold">{a.val!.toFixed(1)}</span><Star className="h-3.5 w-3.5 text-brand-400 fill-brand-400" /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Alerta de bajas */}
      {bajas.length > 0 && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm p-3 inline-flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span><strong>{bajas.length}</strong> reseña{bajas.length !== 1 ? 's' : ''} con 3★ o menos — revisalas y respondé para no perder al cliente.</span>
        </div>
      )}

      {/* Pedir reseñas en Google */}
      {localSel && <PedirResena slug={localSel.slug} nombre={localSel.nombre} />}

      {/* Lista */}
      {cargando ? (
        <div className="py-12 text-center text-ink-muted">Cargando reseñas…</div>
      ) : reviews.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3"><MessageSquare className="h-7 w-7" /></div>
          <p className="font-medium">Sin reseñas todavía</p>
          <p className="text-sm text-ink-muted mt-1">Llegan cuando tus clientes reseñan tras un pedido o visita.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reviews.map((r) => (
            <div key={r.review_id} className={`rounded-2xl bg-white border shadow-card p-4 ${r.rating <= 3 ? 'border-red-200' : 'border-ink/5'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm">{(r.autor_nombre[0] ?? '?').toUpperCase()}</div>
                  <div><div className="text-sm font-medium">{r.autor_nombre}</div><Estrellas n={r.rating} /></div>
                </div>
                <span className="text-xs text-ink-muted">{fechaCorta(r.created_at)}</span>
              </div>
              {r.comentario && <p className="text-sm text-ink-soft mt-2">{r.comentario}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PedirResena({ slug, nombre }: { slug: string | null; nombre: string }) {
  const key = `habitue_google_review_${slug ?? 'x'}`;
  const [link, setLink] = useState(() => (slug ? localStorage.getItem(key) ?? '' : ''));

  function guardar() { if (slug) { localStorage.setItem(key, link.trim()); toast.success('Link guardado'); } }
  const msg = `Hola! ¿Nos dejás una reseña en Google? Nos ayuda muchísimo 🙏\n${link}`;
  const waShare = link ? `https://wa.me/?text=${encodeURIComponent(msg)}` : null;

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 space-y-3">
      <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-brand-500" /><span className="font-medium text-sm">Pedí reseñas en Google Maps</span></div>
      <p className="text-xs text-ink-muted">Pegá el link de reseña de Google de <strong>{nombre}</strong> (lo sacás de tu Perfil de Empresa de Google) y compartilo. Conectando la integración de Google Maps, esto se trae solo + se automatiza tras cada visita.</p>
      <div className="flex gap-2 flex-wrap">
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://g.page/r/…/review"
               className="flex-1 min-w-[200px] rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <button onClick={guardar} className="rounded-lg border border-ink/15 hover:bg-ink/5 px-3 py-2 text-sm font-medium">Guardar</button>
      </div>
      {waShare && (
        <div className="flex gap-2">
          <a href={waShare} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> Pedir por WhatsApp</a>
          <button onClick={() => void navigator.clipboard.writeText(msg).then(() => toast.success('Mensaje copiado'))} className="rounded-lg border border-ink/15 hover:bg-ink/5 px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5"><Copy className="h-4 w-4" /> Copiar</button>
        </div>
      )}
    </div>
  );
}

function Estrellas({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={`h-3.5 w-3.5 ${i <= n ? 'text-brand-400 fill-brand-400' : 'text-ink/15'}`} />)}
    </span>
  );
}
