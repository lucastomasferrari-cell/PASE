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
import { LogOut, CalendarDays, Store, Map, Hourglass, Users, BarChart3 } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { AdminReservas } from './AdminReservas';
import { AdminMapa } from './AdminMapa';
import { AdminEspera } from './AdminEspera';
import { AdminComensales } from './AdminComensales';
import { AdminStats } from './AdminStats';
import { AdminPerfil, type LocalPerfil } from './AdminPerfil';

type Seccion = 'reservas' | 'mapa' | 'espera' | 'comensales' | 'stats' | 'perfil';

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);

  const [locales, setLocales] = useState<LocalPerfil[]>([]);
  const [sel, setSel] = useState<number | null>(null);  // settings_id
  const [seccion, setSeccion] = useState<Seccion>('reservas');

  useEffect(() => {
    if (!supabaseConfigurado) return;
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) setSesion({ email: data.session.user.email });
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

  return (
    <div className="min-h-screen pb-16 bg-crema">
      <header className="container py-5 flex items-center justify-between">
        <span className="font-display text-xl font-semibold text-brand-600">mesa.</span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-ink-muted hidden sm:inline">{sesion.email}</span>
          <button onClick={() => void salir()} className="text-ink-soft hover:text-ink flex items-center gap-1.5">
            <LogOut className="h-4 w-4" /> Salir
          </button>
        </div>
      </header>

      <main className="container">
        {/* Tabs de sección */}
        <div className="flex items-center gap-1 border-b border-ink/10 overflow-x-auto">
          <TabBtn activo={seccion === 'reservas'} onClick={() => setSeccion('reservas')} icon={<CalendarDays className="h-4 w-4" />} label="Reservas" />
          <TabBtn activo={seccion === 'mapa'} onClick={() => setSeccion('mapa')} icon={<Map className="h-4 w-4" />} label="Mapa" />
          <TabBtn activo={seccion === 'espera'} onClick={() => setSeccion('espera')} icon={<Hourglass className="h-4 w-4" />} label="Espera" />
          <TabBtn activo={seccion === 'comensales'} onClick={() => setSeccion('comensales')} icon={<Users className="h-4 w-4" />} label="Comensales" />
          <TabBtn activo={seccion === 'stats'} onClick={() => setSeccion('stats')} icon={<BarChart3 className="h-4 w-4" />} label="Stats" />
          <TabBtn activo={seccion === 'perfil'} onClick={() => setSeccion('perfil')} icon={<Store className="h-4 w-4" />} label="Perfil" />
        </div>

        {/* Selector de local */}
        {locales.length > 1 && (
          <div className="mt-5 flex gap-2 flex-wrap">
            {locales.map((l) => (
              <button key={l.settings_id} onClick={() => setSel(l.settings_id)}
                      className={`rounded-full px-4 py-1.5 text-sm font-medium border transition-colors ${
                        sel === l.settings_id ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'
                      }`}>
                {l.nombre}
              </button>
            ))}
          </div>
        )}

        {localSel ? (
          seccion === 'reservas' ? (
            <AdminReservas localId={localSel.local_id} localNombre={localSel.nombre} />
          ) : seccion === 'mapa' ? (
            <AdminMapa localId={localSel.local_id} />
          ) : seccion === 'espera' ? (
            <AdminEspera localId={localSel.local_id} tenantId={localSel.tenant_id} />
          ) : seccion === 'comensales' ? (
            <AdminComensales />
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
  );
}

function TabBtn({ activo, onClick, icon, label }: { activo: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick}
            className={`px-4 py-2.5 text-sm font-medium inline-flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
              activo ? 'border-brand-500 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink'
            }`}>
      {icon}{label}
    </button>
  );
}
