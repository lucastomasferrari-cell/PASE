// Panel interno de MESA — /admin.
//
// Login real contra el Supabase Auth compartido (mismas cuentas que PASE/
// COMANDA) + EDITOR DEL PERFIL PÚBLICO por local: descripción, fotos (URLs),
// dirección, teléfono, Instagram, web. Es el contenido que muestra /:slug.
// La Agenda/Eventos/Giftcards siguen en COMANDA hasta la mudanza (próximo
// sprint) — acá hay links directos.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, LogOut, ExternalLink, Save } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';

interface LocalPerfil {
  settings_id: number;
  local_id: number;
  nombre: string;
  slug: string | null;
  direccion: string | null;
  telefono: string | null;
  instagram: string | null;
  web: string | null;
  mesa_descripcion: string | null;
  mesa_fotos: string[];
}

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);

  const [locales, setLocales] = useState<LocalPerfil[]>([]);
  const [sel, setSel] = useState<number | null>(null);  // settings_id seleccionado
  const [form, setForm] = useState<LocalPerfil | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    // 'sin config' se deriva en render — el effect solo resuelve la sesión async.
    if (!supabaseConfigurado) return;
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) setSesion({ email: data.session.user.email });
      setCargando(false);
    })();
  }, []);

  // Cargar locales del tenant con su settings al loguear.
  useEffect(() => {
    if (!sesion) return;
    void (async () => {
      const { data, error } = await db()
        .from('comanda_local_settings')
        .select('id, local_id, slug, direccion, telefono, instagram, web, mesa_descripcion, mesa_fotos, locales(nombre)')
        .is('deleted_at', null)
        .order('local_id');
      if (error) { toast.error('No se pudieron cargar los locales: ' + error.message); return; }
      const rows = (data ?? []).map((r) => {
        const row = r as unknown as {
          id: number; local_id: number; slug: string | null; direccion: string | null;
          telefono: string | null; instagram: string | null; web: string | null;
          mesa_descripcion: string | null; mesa_fotos: string[] | null;
          locales: { nombre: string } | null;
        };
        return {
          settings_id: row.id, local_id: row.local_id,
          nombre: row.locales?.nombre ?? `Local ${row.local_id}`,
          slug: row.slug, direccion: row.direccion, telefono: row.telefono,
          instagram: row.instagram, web: row.web,
          mesa_descripcion: row.mesa_descripcion,
          mesa_fotos: Array.isArray(row.mesa_fotos) ? row.mesa_fotos : [],
        } satisfies LocalPerfil;
      });
      setLocales(rows);
      if (rows.length > 0 && sel === null) {
        setSel(rows[0]!.settings_id);
        setForm(rows[0]!);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sesion]);

  function elegirLocal(settingsId: number) {
    const l = locales.find((x) => x.settings_id === settingsId);
    if (!l) return;
    setSel(settingsId);
    setForm({ ...l });
  }

  async function guardar() {
    if (!form) return;
    setGuardando(true);
    try {
      const fotos = form.mesa_fotos.map((f) => f.trim()).filter(Boolean);
      const { error } = await db().from('comanda_local_settings').update({
        direccion: form.direccion?.trim() || null,
        telefono: form.telefono?.trim() || null,
        instagram: form.instagram?.trim() || null,
        web: form.web?.trim() || null,
        mesa_descripcion: form.mesa_descripcion?.trim() || null,
        mesa_fotos: fotos,
        updated_at: new Date().toISOString(),
      }).eq('id', form.settings_id);
      if (error) { toast.error('No se pudo guardar: ' + error.message); return; }
      toast.success('Perfil guardado — la página pública ya lo muestra');
      setLocales((prev) => prev.map((l) => l.settings_id === form.settings_id ? { ...form, mesa_fotos: fotos } : l));
    } finally {
      setGuardando(false);
    }
  }

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
    setLocales([]); setSel(null); setForm(null);
  }

  if (!supabaseConfigurado) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">MESA sin configurar (env vars).</div>;
  }
  if (cargando) return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={entrar} className="w-full max-w-sm rounded-2xl bg-white border border-ink/5 shadow-sm p-6 space-y-4">
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

  return (
    <div className="min-h-screen pb-16">
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
        <h1 className="font-display text-3xl font-semibold">Perfil público</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Lo que ven tus clientes en la página de cada local. Reservas, eventos y
          giftcards se gestionan por ahora en COMANDA (Reservas / Marketing).
        </p>

        {/* selector de local */}
        <div className="mt-6 flex gap-2 flex-wrap">
          {locales.map((l) => (
            <button key={l.settings_id} onClick={() => elegirLocal(l.settings_id)}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium border transition-colors ${
                      sel === l.settings_id ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'
                    }`}>
              {l.nombre}
            </button>
          ))}
        </div>

        {form && (
          <div className="mt-6 grid lg:grid-cols-2 gap-6 max-w-5xl">
            <div className="rounded-2xl bg-white border border-ink/5 shadow-sm p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{form.nombre}</p>
                {form.slug && (
                  <a href={`/${form.slug}`} target="_blank" rel="noopener"
                     className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
                    Ver página pública <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <Campo label="Descripción (la historia del local, 'sobre nosotros')">
                <textarea rows={5} value={form.mesa_descripcion ?? ''}
                          placeholder="En Neko el sushi es cosa seria…"
                          onChange={(e) => setForm((f) => f && ({ ...f, mesa_descripcion: e.target.value }))}
                          className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </Campo>
              <Campo label="Fotos (una URL por línea — la primera es la grande del hero)">
                <textarea rows={4} value={form.mesa_fotos.join('\n')}
                          placeholder={'https://…/fachada.jpg\nhttps://…/salon.jpg'}
                          onChange={(e) => setForm((f) => f && ({ ...f, mesa_fotos: e.target.value.split('\n') }))}
                          className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono" />
              </Campo>
            </div>

            <div className="rounded-2xl bg-white border border-ink/5 shadow-sm p-5 space-y-4 self-start">
              <Campo label="Dirección">
                <input value={form.direccion ?? ''} onChange={(e) => setForm((f) => f && ({ ...f, direccion: e.target.value }))}
                       className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </Campo>
              <Campo label="Teléfono">
                <input value={form.telefono ?? ''} inputMode="tel" onChange={(e) => setForm((f) => f && ({ ...f, telefono: e.target.value }))}
                       className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </Campo>
              <div className="grid grid-cols-2 gap-3">
                <Campo label="Instagram">
                  <input value={form.instagram ?? ''} placeholder="@nekosushiar"
                         onChange={(e) => setForm((f) => f && ({ ...f, instagram: e.target.value }))}
                         className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                </Campo>
                <Campo label="Web">
                  <input value={form.web ?? ''} placeholder="https://…"
                         onChange={(e) => setForm((f) => f && ({ ...f, web: e.target.value }))}
                         className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                </Campo>
              </div>
              <button onClick={() => void guardar()} disabled={guardando}
                      className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2">
                <Save className="h-4 w-4" /> {guardando ? 'Guardando…' : 'Guardar perfil'}
              </button>
              <p className="text-xs text-ink-muted flex items-start gap-1.5">
                <CalendarCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Los horarios, la capacidad de reservas y el catálogo se configuran
                en COMANDA → Configuración; eventos y giftcards en COMANDA →
                Marketing. (Se mudan acá en el próximo sprint.)
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-ink-soft">{label}</label>
      {children}
    </div>
  );
}
