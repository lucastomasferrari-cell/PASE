// Accesos — panel del dueño del local. Login + shell con sidebar morado.
// Centraliza personas, roles, accesos a apps, PIN POS, auditoría, mi cuenta.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  LogOut, ShieldCheck, Users, Grid3x3, KeyRound, ScrollText, User, MapPin, ChevronDown, Check,
} from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { Personas } from './Personas';
import { Roles } from './Roles';
import { Accesos } from './Accesos';
import { PinPos } from './PinPos';
import { Auditoria } from './Auditoria';
import { MiCuenta } from './MiCuenta';

type Seccion = 'personas' | 'roles' | 'accesos' | 'pin' | 'audit' | 'mi_cuenta';

const NAV: { key: Seccion; label: string; icon: React.ReactNode }[] = [
  { key: 'personas', label: 'Personas', icon: <Users className="h-[18px] w-[18px]" /> },
  { key: 'roles', label: 'Roles y permisos', icon: <ShieldCheck className="h-[18px] w-[18px]" /> },
  { key: 'accesos', label: 'Accesos por app', icon: <Grid3x3 className="h-[18px] w-[18px]" /> },
  { key: 'pin', label: 'PIN del POS', icon: <KeyRound className="h-[18px] w-[18px]" /> },
  { key: 'audit', label: 'Auditoría', icon: <ScrollText className="h-[18px] w-[18px]" /> },
  { key: 'mi_cuenta', label: 'Mi cuenta', icon: <User className="h-[18px] w-[18px]" /> },
];

interface LocalLite { id: number; nombre: string; }

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);

  const [locales, setLocales] = useState<LocalLite[]>([]);
  const [localSel, setLocalSel] = useState<number | null>(null);
  const [seccion, setSeccion] = useState<Seccion>('personas');

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
      const { data } = await db().from('locales').select('id, nombre').is('deleted_at', null).order('nombre');
      const rows = (data ?? []) as LocalLite[];
      setLocales(rows);
      if (rows.length > 0 && localSel === null) setLocalSel(rows[0]!.id);
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

      // Gating apps_permitidas. Accesos es de uso casi exclusivo del dueño;
      // por eso, además de chequear apps_permitidas, exigimos rol dueno/admin/superadmin.
      const { data: perfil } = await db().from('usuarios')
        .select('apps_permitidas, rol')
        .eq('auth_id', data.session.user.id)
        .maybeSingle();
      const apps = (perfil?.apps_permitidas as string[] | null) ?? ['pase'];
      const rol = perfil?.rol as string | undefined;
      if (!apps.includes('accesos')) {
        toast.error('Tu cuenta no tiene acceso a Accesos. Pedile al dueño que te habilite.');
        await db().auth.signOut();
        return;
      }
      if (!rol || !['dueno', 'admin', 'superadmin'].includes(rol)) {
        toast.error('Accesos es solo para el dueño / admin del local.');
        await db().auth.signOut();
        return;
      }

      setSesion({ email: data.session.user.email ?? mail });
    } finally { setEntrando(false); }
  }

  async function salir() {
    await db().auth.signOut();
    setSesion(null); setLocales([]); setLocalSel(null);
  }

  if (!supabaseConfigurado) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">Accesos sin configurar (env vars).</div>;
  }
  if (cargando) return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={entrar} className="w-full max-w-sm rounded-2xl bg-white border border-ink/5 shadow-card p-6 space-y-4">
          <div>
            <span className="font-display text-2xl font-semibold text-brand-700">accesos<span className="text-brand-400">.</span></span>
            <p className="text-sm text-ink-muted mt-1">Gestión de personas y accesos del ecosistema.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="eq-email" className="text-sm font-medium">Usuario o email</label>
            <input id="eq-email" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="eq-pass" className="text-sm font-medium">Contraseña</label>
            <input id="eq-pass" type="password" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
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
    <div className="min-h-screen bg-crema md:flex">
      <aside className="hidden md:flex md:flex-col md:w-60 md:fixed md:inset-y-0 bg-white border-r border-ink/10 z-30">
        <div className="px-5 h-16 flex items-center">
          <span className="font-display text-2xl font-semibold text-brand-700">accesos<span className="text-brand-400">.</span></span>
        </div>
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          {NAV.map((it) => (
            <button key={it.key} onClick={() => setSeccion(it.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      seccion === it.key ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-ink/5'
                    }`}>
              {it.icon}<span className="flex-1 text-left">{it.label}</span>
            </button>
          ))}
        </nav>
        <div className="border-t border-ink/10 p-3">
          <div className="px-2 pb-2 text-xs text-ink-muted truncate" title={sesion.email}>{sesion.email}</div>
          <button onClick={() => void salir()} className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-ink-soft hover:bg-ink/5">
            <LogOut className="h-4 w-4" /> Salir
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 md:pl-60 flex flex-col min-h-screen">
        <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-ink/10 h-16 flex items-center gap-3 px-4 sm:px-6">
          <span className="md:hidden font-display text-xl font-semibold text-brand-700">accesos<span className="text-brand-400">.</span></span>
          <h1 className="font-display text-lg font-semibold capitalize">{NAV.find((n) => n.key === seccion)?.label}</h1>
          {locales.length > 1 && seccion === 'pin' && (
            <LocalSwitcher locales={locales} sel={localSel} onSelect={setLocalSel} />
          )}
          <button onClick={() => void salir()} className="md:hidden ml-auto text-ink-soft hover:text-ink p-2" title="Salir"><LogOut className="h-5 w-5" /></button>
        </header>

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

        <main className="flex-1 px-4 sm:px-6 py-6">
          {seccion === 'personas' ? <Personas />
            : seccion === 'roles' ? <Roles />
            : seccion === 'accesos' ? <Accesos />
            : seccion === 'pin' ? <PinPos localId={localSel} locales={locales} />
            : seccion === 'audit' ? <Auditoria />
            : <MiCuenta email={sesion.email} />}
        </main>
      </div>
    </div>
  );
}

function LocalSwitcher({ locales, sel, onSelect }: { locales: LocalLite[]; sel: number | null; onSelect: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const actual = locales.find((l) => l.id === sel);
  return (
    <div className="relative ml-auto sm:ml-4">
      <button onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-sm font-medium hover:border-brand-300 max-w-[220px]">
        <MapPin className="h-4 w-4 text-brand-500 shrink-0" />
        <span className="truncate">{actual?.nombre ?? 'Elegí local'}</span>
        <ChevronDown className={`h-4 w-4 text-ink-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-40 w-56 rounded-xl border border-ink/10 bg-white shadow-card py-1.5">
            {locales.map((l) => (
              <button key={l.id} onClick={() => { onSelect(l.id); setOpen(false); }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-brand-50/60 ${l.id === sel ? 'text-brand-700 font-medium' : 'text-ink'}`}>
                <span className="truncate">{l.nombre}</span>
                {l.id === sel && <Check className="h-4 w-4 text-brand-500 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
