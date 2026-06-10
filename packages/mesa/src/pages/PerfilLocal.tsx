// Página pública del local — /:slug.
//
// HOY: esqueleto funcional que ya habla con la base (prueba el wiring
// end-to-end del slug). El perfil completo — galería, descripción, platos
// recomendados, reviews, eventos, giftcards, "¿hay mesa ahora?" — se
// construye en el sprint visual dedicado (spec módulo #4).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarCheck, MapPin } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';

interface InfoPublica {
  local_nombre?: string | null;
  nombre?: string | null;
  direccion?: string | null;
  reservas_activas?: boolean | null;
}

export function PerfilLocal() {
  const { slug } = useParams<{ slug: string }>();
  const [info, setInfo] = useState<InfoPublica | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'ok' | 'no-existe'>('cargando');

  // 'sin-config' y 'sin slug' se derivan en render (no son estado async).
  const puedeCargar = supabaseConfigurado && Boolean(slug);

  useEffect(() => {
    if (!puedeCargar || !slug) return;
    let cancel = false;
    void (async () => {
      const { data, error } = await db().rpc('fn_get_reservas_info_publico', { p_local_slug: slug });
      if (cancel) return;
      if (error || !data) { setEstado('no-existe'); return; }
      setInfo(data as InfoPublica);
      setEstado('ok');
    })();
    return () => { cancel = true; };
  }, [slug, puedeCargar]);

  if (!supabaseConfigurado) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">MESA sin configurar (env vars).</div>;
  }
  if (estado === 'cargando' && puedeCargar) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;
  }
  if (!slug || estado === 'no-existe') {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-center">
          <p className="font-display text-3xl">Ese local no existe</p>
          <p className="mt-2 text-ink-muted">Revisá el link o consultale al restaurante.</p>
        </div>
      </div>
    );
  }

  const nombre = info?.local_nombre || info?.nombre || slug;
  return (
    <div className="min-h-screen">
      <header className="container py-5 flex items-center justify-between">
        <span className="font-display text-xl font-semibold text-brand-600">mesa.</span>
      </header>
      <main className="container py-10 max-w-3xl">
        <h1 className="font-display text-4xl font-semibold">{nombre}</h1>
        {info?.direccion && (
          <p className="mt-2 text-ink-soft flex items-center gap-1.5">
            <MapPin className="h-4 w-4" /> {info.direccion}
          </p>
        )}
        <div className="mt-8 rounded-2xl bg-white border border-ink/5 shadow-sm p-6">
          <p className="font-medium flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-brand-500" /> Reservá tu mesa
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            El perfil completo de este local (fotos, qué pedir, reseñas, eventos
            y giftcards) está en construcción. Muy pronto acá. ✨
          </p>
        </div>
      </main>
    </div>
  );
}
