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
  getPerfil, crearReservaPublica, notificarConfirmacionReserva,
  getZonasReservables, getSlotsDisponibilidad, inscribirEventoYPagar, comprarGiftcardYPagar,
  type PerfilLocalData, type SlotDisponibilidad,
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
        <p className="text-3xl">Ese local no existe</p>
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
        <Link to="/" className="text-xl font-medium text-brand-600">mesa.</Link>
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
            <h1 className="text-4xl md:text-5xl font-medium">{local.nombre}</h1>
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
        <span>Reservas por <span className="font-medium text-brand-600">mesa.</span></span>
        <span>Sin comisión por cubierto.</span>
      </footer>
    </div>
  );
}

// ─── Widget de reserva ───────────────────────────────────────────────────────

// Traduce los códigos de la RPC de reservas a texto amable para el cliente.
const MOTIVOS_RESERVA: Record<string, string> = {
  LOCAL_NO_ENCONTRADO: 'No encontramos el local.',
  RESERVAS_DESACTIVADAS: 'Este local no está tomando reservas online.',
  PERSONAS_INVALIDAS: 'Revisá la cantidad de personas.',
  ANTICIPACION_INSUFICIENTE: 'Necesitás reservar con un poco más de anticipación.',
  FECHA_DEMASIADO_LEJANA: 'Esa fecha es demasiado lejana para reservar.',
  CERRADO_ESE_DIA: 'El local está cerrado ese día.',
  FUERA_DE_HORARIO: 'Ese horario está fuera del horario de atención.',
  SIN_CUPO: 'No hay lugar en ese horario. Probá otro.',
  TELEFONO_REQUERIDO: 'El teléfono es obligatorio.',
  NOMBRE_REQUERIDO: 'Ingresá tu nombre.',
  DEMASIADAS_RESERVAS: 'Ya tenés varias reservas activas con ese teléfono.',
  DEMASIADO_RAPIDO: 'Estamos recibiendo muchas reservas. Probá en un momento.',
};
function traducirMotivoReserva(codigo?: string | null): string {
  if (!codigo) return 'No se pudo completar la reserva. Probá otro horario.';
  return MOTIVOS_RESERVA[codigo.trim()] ?? codigo;
}

function ReservaWidget({ slug, perfil }: { slug: string; perfil: PerfilLocalData }) {
  const hoy = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);
  const [personas, setPersonas] = useState(2);
  const [fecha, setFecha] = useState(hoy);
  const [hora, setHora] = useState('21:00');
  const [zonas, setZonas] = useState<string[]>([]);
  const [zona, setZona] = useState<string | null>(null); // null = cualquier sector
  const [paso, setPaso] = useState<'buscar' | 'datos' | 'lista'>('buscar');
  const [slots, setSlots] = useState<SlotDisponibilidad[]>([]);
  const [cargandoSlots, setCargandoSlots] = useState(false);
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [notas, setNotas] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [estadoFinal, setEstadoFinal] = useState<string>('pendiente');

  // Cargar los sectores reservables (Barra/Salón/Terraza/…) del local.
  useEffect(() => {
    let vivo = true;
    void getZonasReservables(slug).then((z) => { if (vivo) setZonas(z); });
    return () => { vivo = false; };
  }, [slug]);

  // Próximos 14 días para el scroller de fecha.
  const dias = useMemo(() => {
    const out: { iso: string; dow: string; num: string }[] = [];
    const base = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({
        iso,
        dow: d.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', ''),
        num: String(d.getDate()),
      });
    }
    return out;
  }, []);

  // Traer los horarios disponibles cada vez que cambia fecha/personas/sector.
  useEffect(() => {
    if (paso !== 'buscar') return;
    let vivo = true;
    setCargandoSlots(true);
    void getSlotsDisponibilidad(slug, fecha, personas, zona).then((s) => {
      if (vivo) { setSlots(s); setCargandoSlots(false); }
    });
    return () => { vivo = false; };
  }, [slug, fecha, personas, zona, paso]);

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

  function elegirSlot(h: string) { setHora(h); setPaso('datos'); }

  const slotsLibres = slots.filter((s) => s.disponible);
  const ultimoLibre = slotsLibres[slotsLibres.length - 1]?.hora ?? null;

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) { toast.error('Tu nombre es obligatorio'); return; }
    if (perfil.reservas.telefono_obligatorio && !telefono.trim()) { toast.error('El teléfono es obligatorio'); return; }
    setConfirmando(true);
    try {
      const r = await crearReservaPublica({
        slug, nombre: nombre.trim(), telefono: telefono.trim(),
        email: email.trim() || undefined,
        fechaHora: fechaHoraISO(), personas, notas: notas || undefined, zona,
      });
      if (!r.ok) { toast.error(traducirMotivoReserva(r.error)); return; }
      // Confirmación automática al cliente (email). Fire-and-forget.
      if (r.id && email.trim()) void notificarConfirmacionReserva(r.id);
      setEstadoFinal(r.estado ?? 'pendiente');
      setPaso('lista');
    } finally { setConfirmando(false); }
  }

  if (paso === 'lista') {
    return (
      <div className="rounded-2xl bg-white border border-green-200 shadow-card p-6 text-center">
        <CalendarCheck className="h-10 w-10 text-green-600 mx-auto" />
        <p className="mt-3 text-2xl">¡Listo, {nombre.split(' ')[0]}!</p>
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
    <div className="rounded-3xl bg-white border border-slate-100 shadow-[0_20px_50px_rgba(0,0,0,0.05)] overflow-hidden">
      {/* Header */}
      <div className="p-5 pb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-bold text-slate-900 tracking-tight">Reservá tu mesa</p>
          <p className="text-xs text-slate-500 mt-0.5">{perfil.local.nombre}</p>
        </div>
        {paso === 'buscar' && slotsLibres.length > 0 && (
          <div className="bg-brand-50 px-2.5 py-1 rounded-full flex items-center gap-1.5 border border-brand-500/20 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
            <span className="text-[10px] font-semibold text-brand-600 uppercase tracking-wide whitespace-nowrap">{slotsLibres.length} con lugar</span>
          </div>
        )}
      </div>

      {paso === 'buscar' && (
        <div className="px-5 pb-5 space-y-6">
          {/* Comensales */}
          <div>
            <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Comensales</label>
            <div className="flex items-center justify-between bg-slate-50 p-1.5 rounded-2xl border border-slate-100">
              <button type="button" onClick={() => setPersonas((p) => Math.max(1, p - 1))}
                      className="w-10 h-10 grid place-items-center rounded-xl bg-white shadow-sm border border-slate-200 text-slate-600 text-lg hover:bg-slate-50">−</button>
              <div className="flex flex-col items-center">
                <span className="text-lg font-bold text-slate-800">{personas}</span>
                <span className="text-[9px] text-slate-400 font-medium uppercase">{personas === 1 ? 'persona' : 'personas'}</span>
              </div>
              <button type="button" onClick={() => setPersonas((p) => Math.min(20, p + 1))}
                      className="w-10 h-10 grid place-items-center rounded-xl bg-white shadow-sm border border-slate-200 text-slate-600 text-lg hover:bg-slate-50">+</button>
            </div>
          </div>

          {/* Fecha */}
          <div>
            <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Fecha</label>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {dias.map((d) => (
                <button key={d.iso} type="button" onClick={() => setFecha(d.iso)}
                        className={`flex-shrink-0 w-14 py-2.5 rounded-2xl border-2 flex flex-col items-center transition-all ${
                          fecha === d.iso ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-transparent bg-slate-50 text-slate-700 hover:bg-slate-100'
                        }`}>
                  <span className="text-[10px] font-bold uppercase">{d.dow}</span>
                  <span className="text-base font-bold">{d.num}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Sector */}
          {zonas.length > 0 && (
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Sector</label>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setZona(null)}
                        className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                          zona === null ? 'border-2 border-brand-500 text-brand-600 bg-brand-50' : 'border border-slate-200 text-slate-600 bg-white hover:border-brand-300'
                        }`}>Cualquier lugar</button>
                {zonas.map((z) => (
                  <button key={z} type="button" onClick={() => setZona(z)}
                          className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                            zona === z ? 'border-2 border-brand-500 text-brand-600 bg-brand-50' : 'border border-slate-200 text-slate-600 bg-white hover:border-brand-300'
                          }`}>{z}</button>
                ))}
              </div>
            </div>
          )}

          {/* Horarios */}
          <div>
            <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2 block">Horarios disponibles</label>
            {cargandoSlots ? (
              <p className="text-sm text-slate-400 py-6 text-center">Buscando horarios…</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-slate-500 bg-slate-50 rounded-xl px-3 py-5 text-center">
                No hay horarios ese día. Probá otra fecha{zona ? ' u otro sector' : ''}.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {slots.map((s) => {
                  const pocos = s.disponible && s.restantes >= 1 && s.restantes <= 3;
                  const ultimo = s.disponible && s.hora === ultimoLibre && slotsLibres.length > 1;
                  return (
                    <button key={s.hora} type="button" disabled={!s.disponible}
                            onClick={() => elegirSlot(s.hora)}
                            className={`relative flex flex-col items-center justify-center py-3 rounded-2xl border text-sm font-bold transition-all overflow-hidden ${
                              !s.disponible
                                ? 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
                                : 'border-slate-200 bg-white text-slate-800 hover:border-brand-500 hover:bg-brand-50'
                            }`}>
                      <span className={!s.disponible ? 'line-through' : ''}>{s.hora}</span>
                      {!s.disponible && <span className="text-[8px] font-bold text-red-400 uppercase mt-0.5">Lleno</span>}
                      {ultimo && <span className="absolute top-0 right-0 bg-red-500 text-[7px] text-white px-1 py-0.5 rounded-bl-lg font-bold uppercase">Último</span>}
                      {!ultimo && pocos && <span className="absolute top-0 right-0 bg-amber-500 text-[7px] text-white px-1 py-0.5 rounded-bl-lg font-bold uppercase">Quedan {s.restantes}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {paso === 'datos' && (
        <form onSubmit={confirmar} className="px-5 pb-5 pt-1 space-y-3">
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
            <label htmlFor="rw-email" className="text-xs text-ink-muted">Email (para enviarte la confirmación)</label>
            <input id="rw-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   className="mt-1 w-full rounded-lg border border-ink/15 px-2.5 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="rw-notas" className="text-xs text-ink-muted">¿Alguna alergia o intolerancia? (opcional)</label>
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
          <p className="text-[11px] normal-case tracking-wide text-brand-600 font-medium">Evento</p>
          <p className="text-lg font-medium leading-snug">{e.titulo}</p>
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
          <p className="text-lg font-medium leading-snug">{g.nombre}</p>
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
  return <h2 className="text-2xl font-medium mb-4 flex items-center gap-2">{icon}{children}</h2>;
}
function InfoRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-center gap-2 text-ink-soft">{icon}{children}</p>;
}
