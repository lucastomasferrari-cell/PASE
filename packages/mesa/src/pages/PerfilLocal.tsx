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
  Gift, Sparkles, MessageCircle,
} from 'lucide-react';
import { whatsAppUrl } from '@/lib/whatsapp';
import { supabaseConfigurado } from '@/lib/supabase';
import {
  getPerfil, crearReservaPublica, notificarConfirmacionReserva, getCancelToken,
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
  const [estado, setEstado] = useState<'cargando' | 'ok' | 'no-existe' | 'error'>('cargando');

  useEffect(() => {
    if (!supabaseConfigurado || !slug) return;
    let cancel = false;
    void (async () => {
      const { data: p, error } = await getPerfil(slug);
      if (cancel) return;
      if (error) { setEstado('error'); return; }
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
  if (estado === 'error') {
    return (
      <Centro>
        <p className="text-3xl">Hubo un problema</p>
        <p className="mt-2 text-ink-muted">No pudimos cargar la página. Reintentá en un momento.</p>
      </Centro>
    );
  }
  if (!slug || estado === 'no-existe' || !perfil) {
    return (
      <Centro>
        <p className="text-3xl">Ese local no existe</p>
        <p className="mt-2 text-ink-muted">Revisá el link o consultale al restaurante.</p>
      </Centro>
    );
  }

  const { local, reviews, populares, eventos, giftcards } = perfil;
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

      {/* Masthead editorial */}
      <div className="container mb-8">
        <div className="border-b-2 border-neutral-900 pb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="leading-[0.82]">
              <span className="block font-display uppercase tracking-tighter text-6xl md:text-8xl text-neutral-900">
                {local.nombre.split(' ')[0]}
              </span>
              {local.nombre.split(' ').slice(1).join(' ') && (
                <span className="block font-serif italic font-light text-4xl md:text-5xl text-neutral-400 mt-1">
                  {local.nombre.split(' ').slice(1).join(' ')}
                </span>
              )}
            </h1>
          </div>
          {local.direccion && (
            <a className="md:text-right group" target="_blank" rel="noopener"
               href={`https://maps.google.com/?q=${encodeURIComponent(`${local.nombre} ${local.direccion}`)}`}>
              <div className="flex items-center md:justify-end gap-1.5 font-bold text-neutral-900 text-sm uppercase tracking-widest group-hover:opacity-60">
                <MapPin className="h-4 w-4" /> {local.direccion}
              </div>
              <p className="text-[11px] text-neutral-400 uppercase tracking-wide mt-1">Reservá tu mesa online</p>
            </a>
          )}
        </div>
      </div>

      {/* hero: galería (grayscale editorial) */}
      {fotos.length > 0 ? (
        <div className="container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 overflow-hidden h-64 md:h-80">
            <img src={fotos[0]} alt={local.nombre} className="col-span-2 row-span-2 h-full w-full object-cover grayscale hover:grayscale-0 transition-all duration-700" />
            {fotos.slice(1, 5).map((f, i) => (
              <img key={i} src={f} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover hidden md:block grayscale hover:grayscale-0 transition-all duration-700" />
            ))}
          </div>
        </div>
      ) : (
        <div className="container">
          <div className="h-40 bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700" />
        </div>
      )}

      <main className="container mt-10 grid lg:grid-cols-[1fr_360px] gap-10">
        {/* ── Columna principal ─────────────────────────────────────────── */}
        <div className="space-y-12 min-w-0">
          <section>
            <div className="flex items-center gap-4 flex-wrap text-sm text-ink-soft">
              {reviews.resumen?.total ? (
                <span className="inline-flex items-center gap-1 font-medium text-ink">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  {Number(reviews.resumen.promedio).toFixed(1)}
                  <span className="text-ink-muted font-normal">({reviews.resumen.total} reseñas verificadas)</span>
                </span>
              ) : null}
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
                      ? <img src={p.foto_url} alt={p.nombre} loading="lazy" decoding="async" className="h-28 w-full object-cover grayscale hover:grayscale-0 transition-all duration-500" />
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

          {/* "Más locales del grupo" — oculto por pedido de Lucas (01-jul). El dato
              (perfil.hermanos) sigue disponible para reactivarlo cuando quiera. */}
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
  const [dietas, setDietas] = useState<string[]>([]);
  const toggleDieta = (d: string) => setDietas((xs) => xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]);
  const [confirmando, setConfirmando] = useState(false);
  const [estadoFinal, setEstadoFinal] = useState<string>('pendiente');
  const [reservaId, setReservaId] = useState<number | null>(null);
  const [cancelToken, setCancelToken] = useState<string | null>(null);

  // Cargar los sectores reservables (Barra/Salón/Terraza/…) del local.
  useEffect(() => {
    let vivo = true;
    void getZonasReservables(slug).then((z) => { if (vivo) setZonas(z); });
    return () => { vivo = false; };
  }, [slug]);

  // Scroller de fecha: sólo los días que el negocio ABRE (según horarios del
  // local), hasta 30 días abiertos hacia adelante. Así no se muestran días
  // cerrados (que darían "sin turnos") y se puede llegar a fechas futuras.
  const dias = useMemo(() => {
    // getDay(): 0=Dom … 6=Sáb → clave de horarios
    const keys = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;
    const hor = perfil.local.horarios;
    const out: { iso: string; dow: string; num: string; mes: string }[] = [];
    const base = new Date();
    for (let i = 0; i < 120 && out.length < 30; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const k = keys[d.getDay()]!;
      if (hor && !hor[k]) continue; // cerrado ese día
      out.push({
        iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        dow: d.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', ''),
        num: String(d.getDate()),
        mes: d.toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''),
      });
    }
    return out;
  }, [perfil.local.horarios]);

  // Si la fecha elegida cayó en un día cerrado (o es la de hoy y hoy cierra),
  // saltar al primer día abierto disponible.
  useEffect(() => {
    if (dias.length && !dias.some((d) => d.iso === fecha)) setFecha(dias[0]!.iso);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias]);

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

  // Forzar hora Argentina (-03) en vez de la TZ del navegador: si no, un
  // cliente con el reloj en otra zona (turista/roaming) reservaba una hora
  // distinta a la del chip que tocó. AR no tiene horario de verano → -03 fijo.
  const fechaHoraISO = () => new Date(`${fecha}T${hora}:00-03:00`).toISOString();

  function elegirSlot(h: string) { setHora(h); setPaso('datos'); }

  const slotsLibres = slots.filter((s) => s.disponible);
  const ultimoLibre = slotsLibres[slotsLibres.length - 1]?.hora ?? null;

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) { toast.error('Tu nombre es obligatorio'); return; }
    if (perfil.reservas.telefono_obligatorio && !telefono.trim()) { toast.error('El teléfono es obligatorio'); return; }
    if (perfil.reservas.email_obligatorio && !email.trim()) { toast.error('El email es obligatorio (te mandamos la confirmación ahí)'); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { toast.error('Revisá el email, no parece válido'); return; }
    // Las dietas elegidas se suman a las notas para que el local las vea.
    const dietasTxt = dietas.length ? `Dietas: ${dietas.join(', ')}.` : '';
    const notasFinal = [dietasTxt, notas.trim()].filter(Boolean).join(' ');
    setConfirmando(true);
    try {
      const r = await crearReservaPublica({
        slug, nombre: nombre.trim(), telefono: telefono.trim(),
        email: email.trim() || undefined,
        fechaHora: fechaHoraISO(), personas, notas: notasFinal || undefined, zona,
      });
      if (!r.ok) { toast.error(traducirMotivoReserva(r.error)); return; }
      // Confirmación automática al cliente (email). Fire-and-forget.
      if (r.id && email.trim()) void notificarConfirmacionReserva(r.id);
      setEstadoFinal(r.estado ?? 'pendiente');
      setReservaId(r.id ?? null);
      if (r.id) void getCancelToken(r.id, telefono.trim()).then(setCancelToken);
      setPaso('lista');
    } finally { setConfirmando(false); }
  }

  if (paso === 'lista') {
    return (
      <div className="bg-white border-2 border-neutral-900 p-8 text-center">
        <CalendarCheck className="h-10 w-10 text-neutral-900 mx-auto" />
        <p className="mt-4 font-display uppercase tracking-tight text-3xl text-neutral-900">¡Listo!</p>
        <p className="font-serif italic text-neutral-400 text-lg">{nombre.split(' ')[0]}</p>
        <p className="mt-4 text-sm text-neutral-600 font-medium">
          {personas} {personas === 1 ? 'persona' : 'personas'} · {new Date(`${fecha}T${hora}:00`).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
        </p>
        <p className="mt-3 text-xs text-neutral-400 uppercase tracking-widest">
          {estadoFinal === 'pendiente' ? 'El restaurante confirma en breve' : 'Reserva confirmada'}
        </p>
        {(() => {
          const waMsg = `Hola! Hice una reserva a nombre de ${nombre.trim()} para el ${new Date(`${fecha}T${hora}:00`).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} (${personas} ${personas === 1 ? 'persona' : 'personas'}). Quería consultar/modificar.`;
          const waUrl = whatsAppUrl(perfil.local.telefono, waMsg);
          if (!waUrl) return null;
          return (
            <a href={waUrl} target="_blank" rel="noopener noreferrer"
               className="mt-6 inline-flex items-center justify-center gap-2 w-full bg-neutral-900 text-white px-4 py-3 text-[11px] font-bold uppercase tracking-widest hover:bg-neutral-800 transition-colors">
              <MessageCircle className="h-4 w-4" /> Escribir por WhatsApp
            </a>
          );
        })()}
        <p className="mt-3 text-[10px] text-neutral-400">Para cambios o consultas, escribinos por WhatsApp.</p>
        {reservaId && (
          <Link to={`/r/cancelar/${reservaId}${cancelToken ? `?t=${cancelToken}` : ''}`} className="mt-2 inline-block text-[11px] text-neutral-500 underline hover:text-neutral-900">
            Cancelar mi reserva
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white border-2 border-neutral-900 overflow-hidden">
      {/* Header editorial */}
      <div className="p-6 pb-4 flex items-start justify-between gap-2 border-b border-neutral-900/10">
        <div>
          <h2 className="font-display uppercase tracking-tighter text-4xl text-neutral-900 leading-none">Reserva</h2>
          <p className="font-serif italic text-neutral-400 text-lg mt-1">tu mesa</p>
        </div>
        {paso === 'buscar' && slotsLibres.length > 0 && (
          <div className="bg-neutral-900 text-white px-3 py-1 text-[9px] font-bold uppercase tracking-widest shrink-0">
            {slotsLibres.length} libres
          </div>
        )}
      </div>

      {paso === 'buscar' && (
        <div className="p-6 space-y-8">
          {/* Comensales */}
          <div>
            <label className="font-display text-[10px] text-neutral-400 uppercase tracking-widest block mb-4">N.º de comensales</label>
            <div className="flex items-center justify-between border-b-2 border-neutral-900 pb-3">
              <button type="button" aria-label="menos" onClick={() => setPersonas((p) => Math.max(1, p - 1))}
                      className="text-3xl text-neutral-900 hover:opacity-40 transition-opacity w-8">−</button>
              <span className="font-display text-5xl text-neutral-900 tabular-nums">{String(personas).padStart(2, '0')}</span>
              <button type="button" aria-label="más" onClick={() => setPersonas((p) => Math.min(20, p + 1))}
                      className="text-3xl text-neutral-900 hover:opacity-40 transition-opacity w-8">+</button>
            </div>
          </div>

          {/* Fecha */}
          <div>
            <label className="font-display text-[10px] text-neutral-400 uppercase tracking-widest block mb-4">Seleccionar fecha</label>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {dias.map((d) => (
                <button key={d.iso} type="button" onClick={() => setFecha(d.iso)}
                        className={`flex-shrink-0 w-14 h-16 flex flex-col items-center justify-center border transition-all ${
                          fecha === d.iso ? 'bg-neutral-900 text-white border-neutral-900' : 'border-neutral-900/25 text-neutral-900 hover:border-neutral-900'
                        }`}>
                  <span className="text-[10px] font-bold uppercase">{d.dow}</span>
                  <span className="font-display text-lg leading-none mt-0.5">{d.num}</span>
                  <span className="text-[8px] uppercase opacity-60 leading-none mt-0.5">{d.mes}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Sector */}
          {zonas.length > 0 && (
            <div>
              <label className="font-display text-[10px] text-neutral-400 uppercase tracking-widest block mb-3">Ubicación</label>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setZona(null)}
                        className={`px-4 py-2 border text-[10px] font-bold uppercase tracking-widest transition-all ${
                          zona === null ? 'bg-neutral-900 text-white border-neutral-900' : 'border-neutral-900/30 text-neutral-900 hover:border-neutral-900'
                        }`}>Cualquier lugar</button>
                {zonas.map((z) => (
                  <button key={z} type="button" onClick={() => setZona(z)}
                          className={`px-4 py-2 border text-[10px] font-bold uppercase tracking-widest transition-all ${
                            zona === z ? 'bg-neutral-900 text-white border-neutral-900' : 'border-neutral-900/30 text-neutral-900 hover:border-neutral-900'
                          }`}>{z}</button>
                ))}
              </div>
            </div>
          )}

          {/* Horarios */}
          <div>
            <label className="font-display text-[10px] text-neutral-400 uppercase tracking-widest block mb-3">Turnos disponibles</label>
            {cargandoSlots ? (
              <p className="text-sm text-neutral-400 py-6 text-center">Buscando turnos…</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-neutral-500 border border-neutral-900/15 px-3 py-5 text-center">
                No hay turnos ese día. Probá otra fecha{zona ? ' u otro sector' : ''}.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {slots.map((s) => {
                  const pocos = s.disponible && s.restantes >= 1 && s.restantes <= 3;
                  const ultimo = s.disponible && s.hora === ultimoLibre && slotsLibres.length > 1;
                  return (
                    <button key={s.hora} type="button" disabled={!s.disponible}
                            onClick={() => elegirSlot(s.hora)}
                            className={`relative flex flex-col items-center justify-center py-3 border text-sm font-bold transition-all overflow-hidden ${
                              !s.disponible
                                ? 'border-neutral-900/10 text-neutral-900/30 cursor-not-allowed'
                                : 'border-neutral-900/25 text-neutral-900 hover:bg-neutral-900 hover:text-white hover:border-neutral-900'
                            }`}>
                      <span className={!s.disponible ? 'line-through' : ''}>{s.hora}</span>
                      {!s.disponible && <span className="text-[8px] font-bold text-red-400/70 uppercase mt-0.5 no-underline">Lleno</span>}
                      {ultimo && <span className="absolute top-0 right-0 bg-brand-400 text-[7px] text-white px-1 py-0.5 font-bold uppercase">Último</span>}
                      {!ultimo && pocos && <span className="absolute top-0 right-0 bg-brand-400 text-[7px] text-white px-1 py-0.5 font-bold uppercase">Quedan {s.restantes}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {paso === 'datos' && (
        <form onSubmit={confirmar} className="p-6 pt-2 space-y-3">
          <p className="text-[11px] uppercase tracking-widest font-bold text-neutral-900 border border-neutral-900/20 px-3 py-2 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> {personas} {personas === 1 ? 'persona' : 'personas'} · {fecha.split('-').reverse().slice(0, 2).join('/')} · {hora}
          </p>
          <div>
            <label htmlFor="rw-nombre" className="font-display text-[10px] uppercase tracking-widest text-neutral-400">Tu nombre *</label>
            <input id="rw-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                   className="mt-1 w-full border border-neutral-900/20 px-3 py-2 text-sm focus:border-neutral-900 outline-none" />
          </div>
          <div>
            <label htmlFor="rw-tel" className="font-display text-[10px] uppercase tracking-widest text-neutral-400">Teléfono{perfil.reservas.telefono_obligatorio ? ' *' : ''}</label>
            <input id="rw-tel" inputMode="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)}
                   className="mt-1 w-full border border-neutral-900/20 px-3 py-2 text-sm focus:border-neutral-900 outline-none" />
          </div>
          <div>
            <label htmlFor="rw-email" className="font-display text-[10px] uppercase tracking-widest text-neutral-400">Email{perfil.reservas.email_obligatorio ? ' *' : ''} (para la confirmación)</label>
            <input id="rw-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   className="mt-1 w-full border border-neutral-900/20 px-3 py-2 text-sm focus:border-neutral-900 outline-none" />
          </div>
          <div>
            <label className="font-display text-[10px] uppercase tracking-widest text-neutral-400 block mb-2">¿Alguna dieta especial en la mesa? (opcional)</label>
            <div className="flex flex-wrap gap-2">
              {['Vegetariano', 'Vegano', 'Celíaco (sin TACC)', 'Sin lactosa'].map((d) => (
                <button key={d} type="button" onClick={() => toggleDieta(d)}
                        className={`px-3 py-1.5 border text-[10px] font-bold uppercase tracking-widest transition-all ${
                          dietas.includes(d) ? 'bg-neutral-900 text-white border-neutral-900' : 'border-neutral-900/25 text-neutral-900 hover:border-neutral-900'
                        }`}>{d}</button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="rw-notas" className="font-display text-[10px] uppercase tracking-widest text-neutral-400">Alergias, intolerancias o comentarios (opcional)</label>
            <textarea id="rw-notas" rows={2} value={notas} onChange={(e) => setNotas(e.target.value)}
                      className="mt-1 w-full border border-neutral-900/20 px-3 py-2 text-sm focus:border-neutral-900 outline-none" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setPaso('buscar')}
                    className="border border-neutral-900/25 text-neutral-900 px-4 py-3.5 text-[11px] font-bold uppercase tracking-widest hover:bg-neutral-900/5">Volver</button>
            <button type="submit" disabled={confirmando}
                    className="flex-1 bg-neutral-900 hover:bg-neutral-800 text-white py-3.5 text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-60">
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
        {e.foto_url && <img src={e.foto_url} alt={e.titulo} loading="lazy" decoding="async" className="w-32 object-cover hidden sm:block" />}
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
        {g.foto_url && <img src={g.foto_url} alt={g.nombre} loading="lazy" decoding="async" className="w-32 object-cover hidden sm:block" />}
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
  return (
    <h2 className="font-display uppercase tracking-tight text-2xl md:text-3xl text-neutral-900 mb-6 pb-3 border-b-2 border-neutral-900 flex items-center gap-2">
      {icon}{children}
    </h2>
  );
}
function InfoRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-center gap-2 text-ink-soft">{icon}{children}</p>;
}
