// Panel interno de MESA — /admin.
//
// Shell: login (Supabase Auth compartido con PASE/COMANDA) + selector de local
// + navegación entre secciones:
//   · Reservas        → agenda del día, alta/edición, cambios de estado
//   · Perfil público  → lo que ven los clientes en /:slug
//
// La gestión de reservas se mudó de COMANDA a MESA (etapa 1). Eventos/giftcards
// y la config de horarios/capacidad siguen en COMANDA por ahora.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LogOut, CalendarDays, Store, Map, Hourglass, Users, BarChart3, ChevronDown, Check, MapPin, LayoutDashboard, GanttChartSquare, Star, BellRing, Link2, Copy, ExternalLink, X, MessageCircle } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { AdminTablero } from './AdminTablero';
import { AdminDiario } from './AdminDiario';
import { AdminReservas } from './AdminReservas';
import { AdminMapa } from './AdminMapa';
import { AdminEspera } from './AdminEspera';
import { AdminRecordatorios } from './AdminRecordatorios';
import { AdminComensales } from './AdminComensales';
import { AdminResenas } from './AdminResenas';
import { AdminStats } from './AdminStats';
import { AdminPerfil, type LocalPerfil } from './AdminPerfil';

type Seccion = 'tablero' | 'diario' | 'reservas' | 'mapa' | 'espera' | 'recordatorios' | 'comensales' | 'resenas' | 'stats' | 'perfil';

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);

  const [locales, setLocales] = useState<LocalPerfil[]>([]);
  const [sel, setSel] = useState<number | null>(null);  // settings_id
  const [seccion, setSeccion] = useState<Seccion>('tablero');

  useEffect(() => {
    if (!supabaseConfigurado) return;
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) {
        // Fix audit 26-jun ALTO-1: re-chequear apps_permitidas también en
        // restore de sesión existente. Antes solo se chequeaba en entrar(),
        // así que si el dueño quitaba el permiso 'mesa' a un user logueado,
        // el user seguía adentro hasta cerrar manualmente.
        const { data: perfil } = await db().from('usuarios')
          .select('apps_permitidas')
          .eq('auth_id', data.session.user.id)
          .maybeSingle();
        const apps = Array.isArray(perfil?.apps_permitidas)
          ? (perfil.apps_permitidas as string[])
          : ['pase'];
        if (!apps.includes('mesa')) {
          await db().auth.signOut();
          setCargando(false);
          return;
        }
        setSesion({ email: data.session.user.email });
      }
      setCargando(false);
    })();
  }, []);

  useEffect(() => {
    if (!sesion) return;
    void (async () => {
      const { data, error } = await db()
        .from('comanda_local_settings')
        .select('id, local_id, tenant_id, slug, direccion, telefono, instagram, web, mesa_descripcion, mesa_fotos, locales(nombre)')
        .is('deleted_at', null)
        .order('local_id');
      if (error) { toast.error('No se pudieron cargar los locales: ' + error.message); return; }
      const rows = (data ?? []).map((r) => {
        const row = r as unknown as {
          id: number; local_id: number; tenant_id: string; slug: string | null; direccion: string | null;
          telefono: string | null; instagram: string | null; web: string | null;
          mesa_descripcion: string | null; mesa_fotos: string[] | null;
          locales: { nombre: string } | null;
        };
        return {
          settings_id: row.id, local_id: row.local_id, tenant_id: row.tenant_id,
          nombre: row.locales?.nombre ?? `Local ${row.local_id}`,
          slug: row.slug, direccion: row.direccion, telefono: row.telefono,
          instagram: row.instagram, web: row.web,
          mesa_descripcion: row.mesa_descripcion,
          mesa_fotos: Array.isArray(row.mesa_fotos) ? row.mesa_fotos : [],
        } satisfies LocalPerfil;
      });
      setLocales(rows);
      if (rows.length > 0 && sel === null) setSel(rows[0]!.settings_id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sesion]);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEntrando(true);
    try {
      const mail = email.includes('@') ? email : `${email}@pase.local`;
      const { data, error } = await db().auth.signInWithPassword({ email: mail, password });
      if (error || !data.session) { toast.error('Usuario o contraseña incorrectos'); return; }

      // Gating apps_permitidas (migración 202606250700): si la app no está en
      // la lista del usuario, lo sacamos con un mensaje claro. Default ['pase']
      // mantiene back-compat para usuarios pre-migración.
      const { data: perfil } = await db().from('usuarios')
        .select('apps_permitidas')
        .eq('auth_id', data.session.user.id)
        .maybeSingle();
      const apps = (perfil?.apps_permitidas as string[] | null) ?? ['pase'];
      if (!apps.includes('mesa')) {
        toast.error('Tu cuenta no tiene acceso a MESA. Pedile al dueño que te habilite en Accesos.');
        await db().auth.signOut();
        return;
      }

      setSesion({ email: data.session.user.email ?? mail });
    } finally {
      setEntrando(false);
    }
  }

  async function salir() {
    await db().auth.signOut();
    setSesion(null);
    setLocales([]); setSel(null);
  }

  if (!supabaseConfigurado) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">MESA sin configurar (env vars).</div>;
  }
  if (cargando) return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={entrar} className="w-full max-w-sm rounded-2xl bg-white border border-ink/5 shadow-card p-6 space-y-4">
          <div>
            <span className="font-display text-2xl font-semibold text-brand-600">mesa.</span>
            <p className="text-sm text-ink-muted mt-1">Panel del restaurante — misma cuenta que PASE/COMANDA.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="m-email" className="text-sm font-medium">Usuario o email</label>
            <input id="m-email" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm"
                   value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="m-pass" className="text-sm font-medium">Contraseña</label>
            <input id="m-pass" type="password" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button type="submit" disabled={entrando}
                  className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2 text-sm font-medium disabled:opacity-60">
            {entrando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    );
  }

  const localSel = locales.find((l) => l.settings_id === sel) ?? null;

  const NAV: { key: Seccion; label: string; icon: React.ReactNode }[] = [
    { key: 'tablero',    label: 'Tablero',          icon: <LayoutDashboard className="h-[18px] w-[18px]" /> },
    { key: 'diario',     label: 'Diario',           icon: <GanttChartSquare className="h-[18px] w-[18px]" /> },
    { key: 'reservas',   label: 'Reservas',         icon: <CalendarDays className="h-[18px] w-[18px]" /> },
    { key: 'mapa',       label: 'Mapa de mesas',    icon: <Map className="h-[18px] w-[18px]" /> },
    { key: 'espera',     label: 'Lista de espera',  icon: <Hourglass className="h-[18px] w-[18px]" /> },
    { key: 'recordatorios', label: 'Recordatorios', icon: <BellRing className="h-[18px] w-[18px]" /> },
    { key: 'comensales', label: 'Comensales',       icon: <Users className="h-[18px] w-[18px]" /> },
    { key: 'resenas',    label: 'Reseñas',          icon: <Star className="h-[18px] w-[18px]" /> },
    { key: 'stats',      label: 'Informes',         icon: <BarChart3 className="h-[18px] w-[18px]" /> },
    { key: 'perfil',     label: 'Perfil del local', icon: <Store className="h-[18px] w-[18px]" /> },
  ];

  return (
    <div className="min-h-screen bg-crema md:flex">
      {/* Sidebar de navegación (desktop) — estilo OpenTable */}
      <aside className="hidden md:flex md:flex-col md:w-60 md:fixed md:inset-y-0 bg-white border-r border-ink/10 z-30">
        <div className="px-5 h-16 flex items-center">
          <span className="font-display text-2xl font-semibold text-brand-600">mesa.</span>
        </div>
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          {NAV.map((it) => (
            <NavItem key={it.key} activo={seccion === it.key} icon={it.icon} label={it.label}
                     onClick={() => setSeccion(it.key)} />
          ))}
        </nav>
        <div className="border-t border-ink/10 p-3">
          <div className="px-2 pb-2 text-xs text-ink-muted truncate" title={sesion.email}>{sesion.email}</div>
          <button onClick={() => void salir()}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-ink-soft hover:bg-ink/5">
            <LogOut className="h-4 w-4" /> Salir
          </button>
        </div>
      </aside>

      {/* Columna principal */}
      <div className="flex-1 min-w-0 md:pl-60 flex flex-col min-h-screen">
        {/* Topbar con selector de local (dropdown) */}
        <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-ink/10 h-16 flex items-center gap-3 px-4 sm:px-6">
          <span className="md:hidden font-display text-xl font-semibold text-brand-600">mesa.</span>
          <LocationSwitcher locales={locales} sel={sel} onSelect={setSel} />
          <div className="ml-auto flex items-center gap-2">
            <LinkReservasButton slug={localSel?.slug ?? null} nombre={localSel?.nombre ?? ''} />
            <button onClick={() => void salir()} className="md:hidden text-ink-soft hover:text-ink p-2" title="Salir">
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Nav mobile (horizontal) */}
        <nav className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 border-b border-ink/10 bg-white">
          {NAV.map((it) => (
            <button key={it.key} onClick={() => setSeccion(it.key)}
                    className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${
                      seccion === it.key ? 'bg-brand-500 text-white' : 'text-ink-muted hover:bg-ink/5'
                    }`}>
              {it.icon}{it.label}
            </button>
          ))}
        </nav>

        {/* Contenido de la sección */}
        <main className="flex-1 px-4 sm:px-6 pb-16">
          {localSel ? (
            seccion === 'tablero' ? (
              <AdminTablero localId={localSel.local_id} localSlug={localSel.slug} />
            ) : seccion === 'diario' ? (
              <AdminDiario localId={localSel.local_id} localNombre={localSel.nombre} />
            ) : seccion === 'reservas' ? (
              <AdminReservas localId={localSel.local_id} localNombre={localSel.nombre} />
            ) : seccion === 'mapa' ? (
              <AdminMapa localId={localSel.local_id} />
            ) : seccion === 'espera' ? (
              <AdminEspera localId={localSel.local_id} tenantId={localSel.tenant_id} localNombre={localSel.nombre} />
            ) : seccion === 'recordatorios' ? (
              <AdminRecordatorios localId={localSel.local_id} localNombre={localSel.nombre} />
            ) : seccion === 'comensales' ? (
              <AdminComensales tenantId={localSel.tenant_id} />
            ) : seccion === 'resenas' ? (
              <AdminResenas localSlug={localSel.slug} />
            ) : seccion === 'stats' ? (
              <AdminStats localId={localSel.local_id} />
            ) : (
              <AdminPerfil
                local={localSel}
                onSaved={(updated) => setLocales((prev) => prev.map((l) => l.settings_id === updated.settings_id ? updated : l))}
              />
            )
          ) : (
            <div className="mt-10 text-center text-ink-muted">Cargando locales…</div>
          )}
        </main>
      </div>
    </div>
  );
}

// Botón "Link de reservas" siempre visible en el topbar: muestra el link
// público del local (mesa-orpin.vercel.app/:slug), con copiar, abrir y un QR
// para que el cliente escanee desde la mesa.
function LinkReservasButton({ slug, nombre }: { slug: string | null; nombre: string }) {
  const [open, setOpen] = useState(false);
  const link = slug ? `${window.location.origin}/${slug}` : null;
  const waShare = link
    ? `https://wa.me/?text=${encodeURIComponent(`¡Reservá tu mesa en ${nombre || 'nuestro local'}! 🍽️\n${link}`)}`
    : null;

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3 py-2 text-sm font-medium">
        <Link2 className="h-4 w-4" /> <span className="hidden sm:inline">Link de reservas</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-40 w-72 rounded-xl border border-ink/10 bg-white shadow-card p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Link de reservas</p>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-ink/5 text-ink-soft"><X className="h-4 w-4" /></button>
            </div>
            {!link ? (
              <p className="text-sm text-ink-muted">Este local todavía no tiene su página configurada. Cargá la descripción/datos en <span className="font-medium">Perfil del local</span> para activar el link.</p>
            ) : (
              <>
                <p className="text-xs text-ink-muted mb-2">Compartilo con tus clientes para que reserven solos.</p>
                <div className="flex items-center gap-1 rounded-lg border border-ink/15 bg-brand-50/40 px-2 py-1.5 mb-3">
                  <span className="text-xs text-ink-soft truncate flex-1">{link.replace(/^https?:\/\//, '')}</span>
                </div>
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => void navigator.clipboard.writeText(link).then(
                      () => toast.success('Link copiado'), () => toast.error('No se pudo copiar'))}
                    className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5">
                    <Copy className="h-4 w-4" /> Copiar
                  </button>
                  <a href={link} target="_blank" rel="noopener noreferrer"
                     className="flex-1 rounded-lg border border-ink/15 hover:bg-ink/5 py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5">
                    <ExternalLink className="h-4 w-4" /> Abrir
                  </a>
                </div>
                {waShare && (
                  <a href={waShare} target="_blank" rel="noopener noreferrer"
                     className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5 mb-3">
                    <MessageCircle className="h-4 w-4" /> Compartir por WhatsApp
                  </a>
                )}
                <div className="flex flex-col items-center gap-1.5 pt-1 border-t border-ink/5">
                  <p className="text-[11px] text-ink-muted pt-2">QR para imprimir y poner en la mesa</p>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(link)}`}
                    alt="QR del link de reservas" width={140} height={140}
                    className="rounded-lg border border-ink/10"
                  />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function NavItem({ activo, onClick, icon, label }: { activo: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activo ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-ink/5'
            }`}>
      {icon}{label}
    </button>
  );
}

// Selector de local estilo OpenTable: un dropdown con el local actual + lista
// para cambiar. Reemplaza la fila de pills (no escala con varios locales).
function LocationSwitcher({ locales, sel, onSelect }: {
  locales: LocalPerfil[];
  sel: number | null;
  onSelect: (settingsId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const actual = locales.find((l) => l.settings_id === sel);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm font-medium hover:border-brand-300 max-w-[260px]">
        <MapPin className="h-4 w-4 text-brand-500 shrink-0" />
        <span className="truncate">{actual?.nombre ?? 'Elegí un local'}</span>
        <ChevronDown className={`h-4 w-4 text-ink-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-40 w-64 max-h-80 overflow-y-auto rounded-xl border border-ink/10 bg-white shadow-card py-1.5">
            <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-ink-muted">Tus locales</p>
            {locales.map((l) => (
              <button key={l.settings_id}
                      onClick={() => { onSelect(l.settings_id); setOpen(false); }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-brand-50/60 ${
                        l.settings_id === sel ? 'text-brand-700 font-medium' : 'text-ink'
                      }`}>
                <span className="truncate">{l.nombre}</span>
                {l.settings_id === sel && <Check className="h-4 w-4 text-brand-500 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
