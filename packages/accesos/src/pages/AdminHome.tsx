// Accesos — panel del dueño. Shell "Command Center" (17-jul-2026):
// - Fondo carbon con acento celeste + dorado restringido.
// - Sidebar oscuro numerado, hover celeste, indicador de sección activa.
// - Status bar en el header (LIVE dot + tenant + sesión).
// - Login card estilo terminal.
// Centraliza personas, roles, accesos a apps, PIN POS, auditoría, mi cuenta.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  LogOut, ShieldCheck, Users, ScrollText, User, MapPin, ChevronDown, Check, Tags,
  Tablet as TabletIcon, ArrowRight,
} from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { esLocalVisible } from '@/lib/locales';
import { Personas } from './Personas';
import { PosLocal } from './PosLocal';
import { Marcas } from './Marcas';
import { Roles } from './Roles';
import { Auditoria } from './Auditoria';
import { MiCuenta } from './MiCuenta';
import { StatusDot, Button, Input, Label, cn } from '@/components/primitives';

type Seccion = 'personas' | 'pos' | 'roles' | 'marcas' | 'audit' | 'mi_cuenta';

const NAV: { key: Seccion; label: string; num: string; icon: React.ReactNode }[] = [
  { key: 'personas', num: '01', label: 'Personas',          icon: <Users className="h-[18px] w-[18px]" /> },
  { key: 'pos',      num: '02', label: 'POS del local',     icon: <TabletIcon className="h-[18px] w-[18px]" /> },
  { key: 'roles',    num: '03', label: 'Roles',             icon: <ShieldCheck className="h-[18px] w-[18px]" /> },
  { key: 'marcas',   num: '04', label: 'Marcas y locales',  icon: <Tags className="h-[18px] w-[18px]" /> },
  { key: 'audit',    num: '05', label: 'Actividad',         icon: <ScrollText className="h-[18px] w-[18px]" /> },
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
  const [horaLive, setHoraLive] = useState<string>(() => nowHHMMSS());

  // Tick del reloj para el status bar (cada segundo).
  useEffect(() => {
    const id = window.setInterval(() => setHoraLive(nowHHMMSS()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!supabaseConfigurado) return;
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) {
        // Re-chequear apps_permitidas + rol también en restore de sesión
        // existente (defensive: el dueño puede haber quitado el acceso mientras
        // el user estaba logueado). Fix audit 26-jun ALTO-1.
        const { data: perfil } = await db().from('usuarios')
          .select('apps_permitidas, rol')
          .eq('auth_id', data.session.user.id)
          .maybeSingle();
        const apps = Array.isArray(perfil?.apps_permitidas)
          ? (perfil.apps_permitidas as string[])
          : ['pase'];
        const rol = perfil?.rol as string | undefined;
        const rolOk = rol && ['dueno', 'admin', 'superadmin'].includes(rol);
        if (!apps.includes('accesos') || !rolOk) {
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
      const { data } = await db().from('locales').select('id, nombre').order('nombre');
      const rows = ((data ?? []) as LocalLite[]).filter((l) => esLocalVisible(l.nombre));
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
      // exigimos rol dueno/admin/superadmin.
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

  // ─── Estados de arranque / sin sesión ─────────────────────────────────────
  if (!supabaseConfigurado) {
    return (
      <div className="min-h-screen grid place-items-center bg-carbon-900 text-dim-300 font-mono text-sm">
        Accesos sin configurar (env vars).
      </div>
    );
  }
  if (cargando) return <BootScreen />;

  if (!sesion) {
    return <LoginScreen entrando={entrando} email={email} password={password}
                        setEmail={setEmail} setPassword={setPassword} onSubmit={entrar} />;
  }

  // ─── App shell logueada ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-carbon-900 md:flex">
      <AppSidebar
        seccion={seccion}
        setSeccion={setSeccion}
        email={sesion.email}
        onLogout={salir}
      />

      <div className="flex-1 min-w-0 md:pl-64 flex flex-col min-h-screen">
        <StatusBar
          seccion={seccion}
          horaLive={horaLive}
          locales={locales}
          localSel={localSel}
          setLocalSel={setLocalSel}
          userEmail={sesion.email}
          onLogout={salir}
        />

        {/* Nav mobile — chips horizontales. */}
        <nav className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 border-b border-carbon-600 bg-carbon-800">
          {NAV.map((it) => {
            const activo = seccion === it.key;
            return (
              <button
                key={it.key}
                onClick={() => setSeccion(it.key)}
                className={cn(
                  'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono uppercase tracking-widest2 transition-colors',
                  activo
                    ? 'bg-brand-400 text-carbon-900'
                    : 'text-dim-300 hover:bg-carbon-700 hover:text-dim-50',
                )}
              >
                <span>{it.num}</span>
                <span>{it.label}</span>
              </button>
            );
          })}
        </nav>

        <main className="flex-1 px-4 sm:px-6 py-6 min-w-0">
          {seccion === 'personas' ? <Personas />
            : seccion === 'pos' ? <PosLocal localId={localSel} locales={locales} />
            : seccion === 'roles' ? <Roles />
            : seccion === 'marcas' ? <Marcas />
            : seccion === 'audit' ? <Auditoria />
            : <MiCuenta email={sesion.email} />}
        </main>
      </div>
    </div>
  );
}

// ─── Boot / Cargando ──────────────────────────────────────────────────────
function BootScreen() {
  return (
    <div className="min-h-screen grid place-items-center bg-carbon-900">
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2">
          <StatusDot tone="brand" pulse />
          <span className="label-sys">Iniciando sistema</span>
        </div>
        <div className="text-3xl font-medium text-dim-50">
          accesos<span className="text-gold">.</span>
        </div>
      </div>
    </div>
  );
}

// ─── Login card estilo terminal ───────────────────────────────────────────
function LoginScreen({
  entrando, email, password, setEmail, setPassword, onSubmit,
}: {
  entrando: boolean;
  email: string;
  password: string;
  setEmail: (s: string) => void;
  setPassword: (s: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <div className="min-h-screen grid place-items-center px-4 bg-carbon-900 relative overflow-hidden">
      {/* Halo celeste sutil detrás de la tarjeta. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(117,170,219,0.10),transparent_60%)]" />

      <form onSubmit={onSubmit} className="relative w-full max-w-md">
        {/* Barra superior tipo consola. */}
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest2 text-dim-300 mb-2 px-1">
          <div className="flex items-center gap-2">
            <StatusDot tone="live" pulse />
            <span>SYSTEM · READY</span>
          </div>
          <span>ACCESOS.SYS</span>
        </div>

        <div className="bg-carbon-800 border border-carbon-500 rounded-sm shadow-card overflow-hidden">
          {/* Header: logo. */}
          <div className="px-6 pt-6 pb-4 border-b border-carbon-600">
            <div className="text-3xl font-medium text-dim-50">
              accesos<span className="text-gold">.</span>
            </div>
            <p className="text-sm text-dim-200 mt-1">Gestión de personas y accesos del ecosistema.</p>
          </div>

          {/* Form. */}
          <div className="px-6 py-5 space-y-4">
            <div>
              <Label htmlFor="eq-email">Usuario o email</Label>
              <Input
                id="eq-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dueno@empresa.com"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="eq-pass">Contraseña</Label>
              <Input
                id="eq-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <Button
              type="submit"
              variant="terminal"
              size="lg"
              disabled={entrando}
              className="w-full"
              rightIcon={<ArrowRight className="h-4 w-4" />}
            >
              {entrando ? 'Autenticando…' : 'Ejecutar ingreso'}
            </Button>
          </div>

          <div className="px-6 pb-4 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest2 text-dim-400">
            <span>ECOSISTEMA COCINA</span>
            <span>PASE · COMANDA · MESA</span>
          </div>
        </div>
      </form>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────
function AppSidebar({
  seccion, setSeccion, email, onLogout,
}: {
  seccion: Seccion;
  setSeccion: (s: Seccion) => void;
  email: string;
  onLogout: () => void | Promise<void>;
}) {
  return (
    <aside className="hidden md:flex md:flex-col md:w-64 md:fixed md:inset-y-0 z-30 bg-carbon-800 border-r border-carbon-600">
      {/* Logo. */}
      <div className="px-5 h-16 flex items-center justify-between border-b border-carbon-600">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-medium text-dim-50 leading-none">
            accesos<span className="text-gold">.</span>
          </span>
        </div>
        <span className="label-sys mb-0">v.05</span>
      </div>

      {/* Nav numerada. */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <div className="label-sys px-3 mb-2">Módulos</div>
        {NAV.map((it) => {
          const activo = seccion === it.key;
          return (
            <button
              key={it.key}
              onClick={() => setSeccion(it.key)}
              className={cn(
                'group w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm transition-colors relative',
                activo
                  ? 'bg-brand-400/10 text-dim-50'
                  : 'text-dim-200 hover:bg-carbon-700 hover:text-dim-50',
              )}
            >
              {/* Barra vertical de sección activa. */}
              {activo && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-brand-400 rounded-r" />}
              <span className={cn(
                'font-mono text-[10px] tracking-widest2',
                activo ? 'text-brand-400' : 'text-dim-400 group-hover:text-dim-300',
              )}>{it.num}</span>
              {it.icon}
              <span className="flex-1 text-left">{it.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer: mi cuenta + salir. */}
      <div className="border-t border-carbon-600 p-3 space-y-0.5">
        <button
          onClick={() => setSeccion('mi_cuenta')}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 rounded-sm text-sm transition-colors',
            seccion === 'mi_cuenta'
              ? 'bg-brand-400/10 text-dim-50'
              : 'text-dim-200 hover:bg-carbon-700 hover:text-dim-50',
          )}
          title={email}
        >
          <User className="h-4 w-4 shrink-0" />
          <span className="truncate">{email}</span>
        </button>
        <button
          onClick={() => void onLogout()}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-sm text-sm text-dim-300 hover:bg-carbon-700 hover:text-crit transition-colors"
        >
          <LogOut className="h-4 w-4" /> Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

// ─── Status bar (header) ──────────────────────────────────────────────────
function StatusBar({
  seccion, horaLive, locales, localSel, setLocalSel, userEmail, onLogout,
}: {
  seccion: Seccion;
  horaLive: string;
  locales: LocalLite[];
  localSel: number | null;
  setLocalSel: (id: number) => void;
  userEmail: string;
  onLogout: () => void | Promise<void>;
}) {
  const seccionLabel = useMemo(
    () => (seccion === 'mi_cuenta' ? 'MI CUENTA' : NAV.find((n) => n.key === seccion)?.label.toUpperCase()) ?? '',
    [seccion],
  );

  return (
    <header className="sticky top-0 z-20 bg-carbon-900/95 backdrop-blur">
      {/* Fila única tipo Cocina: SYSTEM · SESSION · MOD ... USER. */}
      <div className="hidden md:flex items-center justify-between px-6 h-9 text-[10px] font-mono uppercase tracking-widest2 text-dim-300 border-b border-carbon-600">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <StatusDot tone="live" pulse />
            <span>SYSTEM · LIVE</span>
          </div>
          <span>SESSION · <span className="text-dim-100 tabular-nums">{horaLive}</span></span>
          <span>MOD · {seccionLabel}</span>
        </div>
        <div className="flex items-center gap-5">
          {locales.length > 1 && seccion === 'pos' && (
            <LocalSwitcher locales={locales} sel={localSel} onSelect={setLocalSel} />
          )}
          <span>USER · <span className="text-dim-100">{userEmail}</span></span>
        </div>
      </div>

      {/* Fila mobile: solo logo + botón salir. */}
      <div className="md:hidden h-12 flex items-center gap-3 px-4 border-b border-carbon-600">
        <span className="text-xl font-medium text-dim-50 leading-none">
          accesos<span className="text-gold">.</span>
        </span>
        <button
          onClick={() => void onLogout()}
          className="ml-auto p-2 text-dim-300 hover:text-crit"
          title="Salir"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

// ─── LocalSwitcher (dropdown oscuro) ──────────────────────────────────────
function LocalSwitcher({
  locales, sel, onSelect,
}: {
  locales: LocalLite[];
  sel: number | null;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const actual = locales.find((l) => l.id === sel);
  return (
    <div className="relative ml-auto sm:ml-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-sm border border-carbon-500 bg-carbon-700 px-3 py-1.5 text-sm text-dim-100 hover:border-brand-400 hover:text-dim-50 max-w-[220px] transition-colors"
      >
        <MapPin className="h-4 w-4 text-brand-400 shrink-0" />
        <span className="truncate font-mono text-xs">{actual?.nombre ?? 'ELEGÍ LOCAL'}</span>
        <ChevronDown className={cn('h-4 w-4 text-dim-300 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-40 w-56 rounded-sm border border-carbon-500 bg-carbon-800 shadow-card py-1">
            {locales.map((l) => (
              <button
                key={l.id}
                onClick={() => { onSelect(l.id); setOpen(false); }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors',
                  l.id === sel
                    ? 'text-brand-300 bg-brand-400/10'
                    : 'text-dim-100 hover:bg-carbon-700',
                )}
              >
                <span className="truncate font-mono text-xs">{l.nombre}</span>
                {l.id === sel && <Check className="h-4 w-4 text-brand-400 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── util: HH:MM:SS ─────────────────────────────────────────────────────
function nowHHMMSS(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
