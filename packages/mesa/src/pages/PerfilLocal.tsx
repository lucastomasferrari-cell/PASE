// Página pública del local — /:slug. El "perfil de restaurante completo"
// (mix Blackbird / Tock / Meitre que eligió Lucas):
//   hero con fotos · ¿hay mesa ahora? · widget de reserva · qué pedir (ventas
//   reales) · eventos con prepago MP · giftcards MP · reseñas verificadas ·
//   info + horarios · más locales del grupo.
// Todo sale de UNA llamada (fn_get_perfil_publico_local).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  MapPin, Phone, AtSign, Globe, Clock, Star, Users, CalendarCheck,
  Gift, Sparkles, ChevronRight,
} from 'lucide-react';
import { supabaseConfigurado } from '@/lib/supabase';
import {
  getPerfil, checkDisponibilidad, crearReservaPublica,
  inscribirEventoYPagar, comprarGiftcardYPagar,
  type PerfilLocalData,
} from '@/lib/perfilService';

const fmtARS = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const DIAS: Array<[keyof PerfilLocalData['local']['horarios'], string]> = [
  ['lun', 'Lunes'], ['mar', 'Martes'], ['mie', 'Miércoles'], ['jue', 'Jueves'],
  ['vie', 'Viernes'], ['sab', 'Sábado'], ['dom', 'Domingo'],
];

// ─── Pantalla ────────────────────────────────────────────────────────────────

export function PerfilLocal() {
  const { slug } = useParams<{ slug: string }>();
  const [perfil, setPerfil] = useState<PerfilLocalData | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'ok' | 'no-existe'>('cargando');

  useEffect(() => {
    if (!supabaseConfigurado || !slug) return;
    let cancel = false;
    void (async () => {
      const p = await getPerfil(slug);
      if (cancel) return;
      if (!p) { setEstado('no-existe'); return; }
      setPerfil(p);
      setEstado('ok');
      document.title = `${p.local.nombre} — Reservas | mesa.`;
    })();
    return () => { cancel = true; };
  }, [slug]);

  if (!supabaseConfigurado) {
    return <Centro>MESA sin configurar (env vars).</Centro>;
  }
  if (estado === 'cargando') return <Centro>Cargando…</Centro>;
  if (!slug || estado === 'no-existe' || !perfil) {
    return (
      <Centro>
        <p className="font-display text-3xl">Ese local no existe</p>
        <p className="mt-2 text-ink-muted">Revisá el link o consultale al restaurante.</p>
      </Centro>
    );
  }

  const { local, reviews, populares, eventos, giftcards, hermanos } = perfil;
  const fotos = (local.fotos ?? []).filter(Boolean);

  return (
    <div className="min-h-screen pb-20">
      {/* nav */}
      <header className="container py-4 flex items-center justify-between">
        <Link to="/" className="font-display text-xl font-semibold text-brand-600">mesa.</Link>
        {perfil.hay_mesa_ahora === true && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 text-green-800 text-xs font-medium px-3 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-green-600 animate-pulse" /> Hay mesa ahora
          </span>
        )}
      </header>

      {/* hero: galería o gradiente */}
      {fotos.length > 0 ? (
        <div className="container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 rounded-2xl overflow-hidden h-64 md:h-80">
            <img src={fotos[0]} alt={local.nombre} className="col-span-2 row-span-2 h-full w-full object-cover" />
            {fotos.slice(1, 5).map((f, i) => (
              <img key={i} src={f} alt="" className="h-full w-full object-cover hidden md:block" />
            ))}
          </div>
        </div>
      ) : (
        <div className="container">
          <div className="rounded-2xl h-40 bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700" />
        </div>
      )}

      <main className="container mt-8 grid lg:grid-cols-[1fr_360px] gap-10">
        {/* ── Columna principal ─────────────────────────────────────────── */}
        <div className="space-y-12 min-w-0">
          <section>
            <h1 className="font-display text-4xl md:text-5xl font-semibold">{local.nombre}</h1>
            <div className="mt-3 flex items-center gap-4 flex-wrap text-sm text-ink-soft">
              {reviews.resumen?.total ? (
                <span className="inline-flex items-center gap-1 font-medium text-ink">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  {Number(reviews.resumen.promedio).toFixed(1)}
                  <span className="text-ink-muted font-normal">({reviews.resumen.total} reseñas verificadas)</span>
                </span>
              ) : null}
              {local.direccion && (
                <a className="inline-flex items-center gap-1 hover:text-ink"
                   href={`https://maps.google.com/?q=${encodeURIComponent(`${local.nombre} ${local.direccion}`)}`}
                   target="_blank" rel="noopener">
                  <MapPin className="h-4 w-4" /> {local.direccion}
                </a>
              )}
            </div>
            {local.descripcion && (
              <p className="mt-5 text-ink-soft leading-relaxed max-w-2xl whitespace-pre-line">{local.descripcion}</p>
            )}
          </section>

          {/* Qué pedir — ventas reales */}
          {populares.length > 0 && (
            <section>
              <Titulo icon={<Sparkles className="h-5 w-5 text-brand-500" />}>Qué pedir</Titulo>
              <p className="text-sm text-ink-muted -mt-2 mb-4">Lo más pedido por los comensales este mes — datos reales, no curaduría.</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {populares.map((p) => (
                  <div key={p.nombre} className="rounded-xl bg-white border border-ink/5 overflow-hidden shadow-card">
                    {p.foto_url
                      ? <img src={p.foto_url} alt={p.nombre} className="h-28 w-full object-cover" />
                      : <div className="h-28 bg-gradient-to-br from-crema to-brand-100" />}
                    <div className="p-3">
                      <p className="text-sm font-medium leading-tight">{p.nombre}</p>
                      <p className="text-xs text-ink-muted mt-0.5">{fmtARS(Number(p.precio))}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Eventos */}
          {eventos.length > 0 && (
            <section>
              <Titulo icon={<CalendarCheck className="h-5 w-5 text-brand-500" />}>Eventos</Titulo>
              <div className="space-y-3">
                {eventos.map((e) => <EventoCard key={e.id} evento={e} slug={slug} />)}
              </div>
            </section>
          )}

          {/* Giftcards */}
          {giftcards.length > 0 && (
            <section>
              <Titulo icon={<Gift className="h-5 w-5 text-brand-500" />}>Giftcards para regalar</Titulo>
              <div className="space-y-3">
                {giftcards.map((g) => <GiftcardCard key={g.id} gift={g} slug={slug} />)}
              </div>
            </section>
          )}

          {/* Reseñas */}
          {reviews.ultimas.length > 0 && (
            <section>
              <Titulo icon={<Star className="h-5 w-5 text-brand-500" />}>Lo que dicen los comensales</Titulo>
              <p className="text-sm text-ink-muted -mt-2 mb-4">Solo pueden reseñar quienes realmente consumieron.</p>
              <div className="space-y-3">
                {reviews.ultimas.map((r, i) => (
                  <div key={i} className="rounded-xl bg-white border border-ink/5 p-4 shadow-card">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{r.autor}</span>
                      <span className="inline-flex">
                        {Array.from({ length: 5 }, (_, j) => (
                          <Star key={j} className={`h-3.5 w-3.5 ${j < r.rating ? 'fill-amber-400 text-amber-400' : 'text-ink/15'}`} />
                        ))}
                      </span>
                    </div>
                    {r.comentario && <p className="mt-2 text-sm text-ink-soft">{r.comentario}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Info + horarios */}
          <section>
            <Titulo icon={<Clock className="h-5 w-5 text-brand-500" />}>Información</Titulo>
            <div className="grid sm:grid-cols-2 gap-6">
              <div className="space-y-2 text-sm">
                {local.direccion && <InfoRow icon={<MapPin className="h-4 w-4" />}>{local.direccion}</InfoRow>}
                {local.telefono && <InfoRow icon={<Phone className="h-4 w-4" />}><a href={`tel:${local.telefono}`} className="hover:underline">{local.telefono}</a></InfoRow>}
                {local.instagram && <InfoRow icon={<AtSign className="h-4 w-4" />}><a href={`https://instagram.com/${local.instagram.replace('@', '')}`} target="_blank" rel="noopener" className="hover:underline">@{local.instagram.replace('@', '')}</a></InfoRow>}
                {local.web && <InfoRow icon={<Globe className="h-4 w-4" />}><a href={local.web} target="_blank" rel="noopener" className="hover:underline">{local.web.replace(/^https?:\/\//, '')}</a></InfoRow>}
              </div>
              <div className="text-sm">
                <p className="font-medium mb-2">Horarios</p>
                <div className="space-y-1">
                  {DIAS.map(([k, label]) => (
                    <div key={k} className="flex justify-between gap-4 text-ink-soft">
                      <span>{label}</span>
                      <span className={local.horarios?.[k] ? '' : 'text-ink-muted'}>{local.horarios?.[k] || 'Cerrado'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Más locales del grupo */}
          {hermanos.length > 0 && (
            <section>
              <Titulo icon={<ChevronRight className="h-5 w-5 text-brand-500" />}>Más locales del grupo</Titulo>
              <div className="grid sm:grid-cols-2 gap-3">
                {hermanos.map((h) => (
                  <Link key={h.slug} to={`/${h.slug}`}
                        className="rounded-xl bg-white border border-ink/5 p-4 shadow-card hover:border-brand-300 transition-colors">
                    <p className="font-medium">{h.nombre}</p>
                    {h.direccion && <p className="text-xs text-ink-muted mt-0.5">{h.direccion}</p>}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ── Sidebar: widget de reserva ────────────────────────────────── */}
        <aside className="lg:sticky lg:top-6 self-start">
          <ReservaWidget slug={slug} perfil={perfil} />
        </aside>
      </main>

      <footer className="container mt-16 pt-6 border-t border-ink/10 text-xs text-ink-muted flex items-center justify-between">
        <span>Reservas por <span className="font-display font-semibold text-brand-600">mesa.</span></span>
        <span>Sin comisión por cubierto.</span>
      </footer>
    </div>
  );
}

// ─── Widget de reserva ───────────────────────────────────────────────────────

function ReservaWidget({ slug, perfil }: { slug: string; perfil: PerfilLocalData }) {
  const hoy = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);
  const [personas, setPersonas] = useState(2);
  const [fecha, setFecha] = useState(hoy);
  const [hora, setHora] = useState('21:00');
  const [paso, setPaso] = useState<'buscar' | 'datos' | 'lista'>('buscar');
  const [motivo, setMotivo] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [notas, setNotas] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [estadoFinal, setEstadoFinal] = useState<string>('pendiente');

  if (!perfil.reservas.activas) {
    return (
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <p className="font-medium">Reservas</p>
        <p className="mt-2 text-sm text-ink-muted">
          Este local todavía no toma reservas online.
          {perfil.local.telefono && <> Llamá al <a className="underline" href={`tel:${perfil.local.telefono}`}>{perfil.local.telefono}</a>.</>}
        </p>
      </div>
    );
  }

  const fechaHoraISO = () => new Date(`${fecha}T${hora}:00`).toISOString();

  async function buscar() {
    setBuscando(true);
    setMotivo(null);
    try {
      const r = await checkDisponibilidad(slug, fechaHoraISO(), personas);
      if (r.disponible) setPaso('datos');
      else setMotivo(r.motivo || 'No hay lugar en ese horario. Probá otro.');
    } finally { setBuscando(false); }
  }

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) { toast.error('Tu nombre es obligatorio'); return; }
    if (perfil.reservas.telefono_obligatorio && !telefono.trim()) { toast.error('El teléfono es obligatorio'); return; }
    setConfirmando(true);
    try {
      const r = await crearReservaPublica({
        slug, nombre: nombre.trim(), telefono: telefono.trim(),
        fechaHora: fechaHoraISO(), personas, notas: notas || undefined,
      });
      if (!r.ok) { toast.error(r.error || 'No se pudo crear la reserva'); return; }
      setEstadoFinal(r.estado ?? 'pendiente');
      setPaso('lista');
    } finally { setConfirmando(false); }
  }

  if (paso === 'lista') {
    return (
      <div className="rounded-2xl bg-white border border-green-200 shadow-card p-6 text-center">
        <CalendarCheck className="h-10 w-10 text-green-600 mx-auto" />
        <p className="mt-3 font-display text-2xl">¡Listo, {nombre.split(' ')[0]}!</p>
        <p className="mt-2 text-sm text-ink-soft">
          {personas} personas · {new Date(`${fecha}T${hora}:00`).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          {estadoFinal === 'pendiente'
            ? 'El restaurante va a confirmar tu reserva en breve.'
            : 'Tu reserva quedó confirmada.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
      <p className="font-medium">Configurá tu reserva</p>

      {paso === 'buscar' && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs text-ink-muted">¿Cuántas personas?</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                <button key={n} onClick={() => setPersonas(n)}
                        className={`h-9 w-9 rounded-full text-sm font-medium border transition-colors ${
                          personas === n ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 hover:border-brand-300'
                        }`}>{n}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="rw-fecha" className="text-xs text-ink-muted">Fecha</label>
              <input id="rw-fecha" type="date" min={hoy} value={fecha} onChange={(e) => setFecha(e.target.value)}
                     className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="rw-hora" className="text-xs text-ink-muted">Hora</label>
              <input id="rw-hora" type="time" value={hora} onChange={(e) => setHora(e.target.value)}
                     className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
            </div>
          </div>
          {motivo && <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">{motivo}</p>}
          <button onClick={() => void buscar()} disabled={buscando}
                  className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {buscando ? 'Buscando…' : 'Buscar mesa'}
          </button>
        </div>
      )}

      {paso === 'datos' && (
        <form onSubmit={confirmar} className="mt-4 space-y-3">
          <p className="text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> ¡Hay lugar! {personas}p · {fecha.split('-').reverse().slice(0, 2).join('/')} {hora}
          </p>
          <div>
            <label htmlFor="rw-nombre" className="text-xs text-ink-muted">Tu nombre *</label>
            <input id="rw-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                   className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="rw-tel" className="text-xs text-ink-muted">Teléfono {perfil.reservas.telefono_obligatorio ? '*' : ''}</label>
            <input id="rw-tel" inputMode="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)}
                   className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="rw-notas" className="text-xs text-ink-muted">Notas (alergias, cochecito, cumpleaños…)</label>
            <textarea id="rw-notas" rows={2} value={notas} onChange={(e) => setNotas(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPaso('buscar')}
                    className="rounded-lg border border-ink/15 px-3 py-2.5 text-sm">Volver</button>
            <button type="submit" disabled={confirmando}
                    className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
              {confirmando ? 'Reservando…' : 'Confirmar reserva'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Eventos / Giftcards cards con checkout ──────────────────────────────────

function EventoCard({ evento: e, slug }: { evento: PerfilLocalData['eventos'][number]; slug: string }) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [telefono, setTelefono] = useState('');
  const [cantidad, setCantidad] = useState(2);
  const [pagando, setPagando] = useState(false);
  const agotado = e.cupos_disponibles <= 0;

  async function pagar(ev: React.FormEvent) {
    ev.preventDefault();
    if (!nombre.trim() || !email.trim()) { toast.error('Nombre y email son obligatorios'); return; }
    setPagando(true);
    try {
      const r = await inscribirEventoYPagar({
        slug, eventoId: e.id, nombre: nombre.trim(), email: email.trim(),
        telefono: telefono || undefined, cantidad,
      });
      if (r.error || !r.initPoint) { toast.error(r.error || 'Error iniciando el pago'); return; }
      window.location.href = r.initPoint;  // → MercadoPago Checkout
    } finally { setPagando(false); }
  }

  return (
    <div className="rounded-xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <div className="flex">
        {e.foto_url && <img src={e.foto_url} alt={e.titulo} className="w-32 object-cover hidden sm:block" />}
        <div className="p-4 flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-brand-600 font-medium">Evento</p>
          <p className="font-display text-lg font-semibold leading-snug">{e.titulo}</p>
          {e.descripcion && <p className="mt-1 text-sm text-ink-soft line-clamp-2">{e.descripcion}</p>}
          <div className="mt-2 flex items-center gap-3 text-xs text-ink-muted flex-wrap">
            <span>{new Date(e.fecha_inicio).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="font-medium text-ink">{fmtARS(Number(e.precio_por_persona))} por persona</span>
            <span>{agotado ? 'AGOTADO' : `${e.cupos_disponibles} cupos`}</span>
          </div>
          {!abierto ? (
            <button onClick={() => setAbierto(true)} disabled={agotado}
                    className="mt-3 rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
              {agotado ? 'Sin cupos' : 'Reservar cupo'}
            </button>
          ) : (
            <form onSubmit={pagar} className="mt-3 grid sm:grid-cols-2 gap-2">
              <input placeholder="Tu nombre *" value={nombre} onChange={(ev) => setNombre(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" autoFocus />
              <input placeholder="Email *" inputMode="email" value={email} onChange={(ev) => setEmail(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
              <input placeholder="Teléfono" inputMode="tel" value={telefono} onChange={(ev) => setTelefono(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
              <select value={cantidad} onChange={(ev) => setCantidad(Number(ev.target.value))}
                      className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm bg-white">
                {Array.from({ length: Math.min(8, Math.max(1, e.cupos_disponibles)) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n} {n === 1 ? 'persona' : 'personas'} — {fmtARS(n * Number(e.precio_por_persona))}</option>
                ))}
              </select>
              <button type="submit" disabled={pagando}
                      className="sm:col-span-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
                {pagando ? 'Llevándote a MercadoPago…' : `Pagar ${fmtARS(cantidad * Number(e.precio_por_persona))} con MercadoPago`}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function GiftcardCard({ gift: g, slug }: { gift: PerfilLocalData['giftcards'][number]; slug: string }) {
  const [abierto, setAbierto] = useState(false);
  const [comprador, setComprador] = useState('');
  const [email, setEmail] = useState('');
  const [para, setPara] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [pagando, setPagando] = useState(false);

  async function pagar(ev: React.FormEvent) {
    ev.preventDefault();
    if (!comprador.trim() || !email.trim()) { toast.error('Tu nombre y email son obligatorios'); return; }
    setPagando(true);
    try {
      const r = await comprarGiftcardYPagar({
        slug, giftcardId: g.id, compradorNombre: comprador.trim(), compradorEmail: email.trim(),
        paraNombre: para || undefined, mensaje: mensaje || undefined,
      });
      if (r.error || !r.initPoint) { toast.error(r.error || 'Error iniciando el pago'); return; }
      window.location.href = r.initPoint;
    } finally { setPagando(false); }
  }

  return (
    <div className="rounded-xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <div className="flex">
        {g.foto_url && <img src={g.foto_url} alt={g.nombre} className="w-32 object-cover hidden sm:block" />}
        <div className="p-4 flex-1 min-w-0">
          <p className="font-display text-lg font-semibold leading-snug">{g.nombre}</p>
          {g.descripcion && <p className="mt-1 text-sm text-ink-soft">{g.descripcion}</p>}
          <p className="mt-2 text-sm font-medium">{fmtARS(Number(g.precio))}</p>
          {!abierto ? (
            <button onClick={() => setAbierto(true)}
                    className="mt-3 rounded-lg border border-brand-500 text-brand-600 hover:bg-brand-50 px-4 py-2 text-sm font-medium">
              Regalar
            </button>
          ) : (
            <form onSubmit={pagar} className="mt-3 grid sm:grid-cols-2 gap-2">
              <input placeholder="Tu nombre *" value={comprador} onChange={(ev) => setComprador(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" autoFocus />
              <input placeholder="Tu email * (te mandamos el código)" inputMode="email" value={email} onChange={(ev) => setEmail(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
              <input placeholder="Para (nombre del agasajado)" value={para} onChange={(ev) => setPara(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
              <input placeholder="Mensaje (feliz cumple…)" value={mensaje} onChange={(ev) => setMensaje(ev.target.value)}
                     className="rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
              <button type="submit" disabled={pagando}
                      className="sm:col-span-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
                {pagando ? 'Llevándote a MercadoPago…' : `Pagar ${fmtARS(Number(g.precio))} con MercadoPago`}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mini componentes ────────────────────────────────────────────────────────

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-ink-muted text-center px-6"><div>{children}</div></div>;
}
function Titulo({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <h2 className="font-display text-2xl font-semibold mb-4 flex items-center gap-2">{icon}{children}</h2>;
}
function InfoRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-center gap-2 text-ink-soft">{icon}{children}</p>;
}
