// Accesos — panel del dueño. Shell "Cocina.OS" (17-jul-2026, refactor B):
// - Launcher de una sola columna centrada (sin sidebar), fiel al launcher
//   cocina.os (PASE/cocina/index.html).
// - Status bar superior: dot DORADO "System Live" + SECURITY/SYNC + OPERATOR + reloj vivo.
// - Hero de terminal `root@accesos:~# accesos.os` con cursor parpadeante y log de arranque.
// - Navegación por fila de tabs mono (01 / Personas, 02 / POS, …).
// - Scanline CRT sutil sobre todo.
// Centraliza personas, roles, accesos a apps, PIN POS, auditoría, mi cuenta.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  LogOut, MapPin, ChevronDown, Check, ArrowRight, Shield, Database,
} from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { esLocalVisible } from '@/lib/locales';
import { Personas } from './Personas';
import { PosLocal } from './PosLocal';
import { Marcas } from './Marcas';
import { Roles } from './Roles';
import { Auditoria } from './Auditoria';
import { MiCuenta } from './MiCuenta';
import { Input, Label } from '@/components/primitives';
import { cn } from '@/lib/cn';

type Seccion = 'personas' | 'pos' | 'roles' | 'marcas' | 'audit' | 'mi_cuenta';

const NAV: { key: Seccion; label: string; num: string }[] = [
  { key: 'personas', num: '01', label: 'Personas' },
  { key: 'pos',      num: '02', label: 'POS' },
  { key: 'roles',    num: '03', label: 'Roles' },
  { key: 'marcas',   num: '04', label: 'Marcas' },
  { key: 'audit',    num: '05', label: 'Actividad' },
];

// Log de arranque del hero por sección (sabor "consola").
const BOOT: Record<Seccion, string[]> = {
  personas: ['> AUTH_GATE: VERIFIED', '> ROSTER_01_LOADED: PERSONAS', '> PERMISSION_MATRIX: OK'],
  pos:      ['> AUTH_GATE: VERIFIED', '> MODULE_02: POS_TERMINALS', '> PIN_REGISTRY: SYNCED'],
  roles:    ['> AUTH_GATE: VERIFIED', '> MODULE_03: ROLE_MATRIX', '> PERMISSION_SETS: LOADED'],
  marcas:   ['> AUTH_GATE: VERIFIED', '> MODULE_04: BRAND_REGISTRY', '> LOCALES_MAP: OK'],
  audit:    ['> AUTH_GATE: VERIFIED', '> MODULE_05: ACTIVITY_LOG', '> STREAM: LIVE'],
  mi_cuenta:['> AUTH_GATE: VERIFIED', '> SESSION_OWNER: SELF', '> CREDENTIALS: EDITABLE'],
};

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

  const operator = useMemo(() => {
    const base = (sesion?.email ?? '').split('@')[0] ?? '';
    return base ? base.toUpperCase() : 'OPERATOR';
  }, [sesion]);

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

  // ─── App shell logueada (launcher de una columna) ──────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-carbon-900">
      <div className="scanline" />

      {/* Status bar superior. */}
      <nav className="status-bar sticky top-0 z-40 px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
            <span className="mono text-[10px] font-medium tracking-[0.2em] text-gold uppercase">System Live</span>
          </div>
          <div className="hidden md:flex gap-4 mono text-[10px] text-dim-300">
            <span className="flex items-center gap-1.5"><Shield className="h-3 w-3" /> SECURITY: ENCRYPTED</span>
            <span className="flex items-center gap-1.5"><Database className="h-3 w-3" /> SYNC: OK</span>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          {locales.length > 1 && seccion === 'pos' && (
            <LocalSwitcher locales={locales} sel={localSel} onSelect={setLocalSel} />
          )}
          <button
            onClick={() => setSeccion('mi_cuenta')}
            className="mono text-[10px] text-dim-300 hover:text-dim-50 transition-colors"
            title="Mi cuenta"
          >
            OPERATOR: <span className="text-brand-400">{operator}</span>
          </button>
          <div className="h-4 w-px bg-slate-800" />
          <span className="mono text-[11px] font-medium tabular-nums">{horaLive}</span>
          <button onClick={() => void salir()} className="text-dim-300 hover:text-crit transition-colors" title="Cerrar sesión">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </nav>

      <main className="flex-1 w-full max-w-[1000px] mx-auto px-4 sm:px-6 pt-8 pb-12">
        {/* Hero de terminal. */}
        <header className="mb-8 sm:mb-10 pl-1 sm:pl-2">
          <div className="mono flex items-baseline gap-2 mb-2 flex-wrap">
            <span className="text-brand-400 opacity-70">root@accesos:~#</span>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              accesos<span className="text-gold">.</span><span className="text-dim-300 font-light text-lg sm:text-xl">os</span>
            </h1>
            <span className="cursor" />
          </div>
          <div className="mono text-[10px] text-dim-300 opacity-60 flex flex-col gap-0.5 border-l border-slate-800 pl-4">
            {BOOT[seccion].map((line) => <p key={line}>{line}</p>)}
          </div>
        </header>

        {/* Fila de tabs de módulos. */}
        <nav className="flex gap-5 sm:gap-6 mb-10 sm:mb-12 border-b border-slate-800 pb-1 overflow-x-auto whitespace-nowrap scrollbar-hide">
          {NAV.map((it) => {
            const activo = seccion === it.key;
            return (
              <button
                key={it.key}
                onClick={() => setSeccion(it.key)}
                className={cn(
                  'mono text-[11px] tracking-[0.2em] uppercase pb-2 transition-colors',
                  activo
                    ? 'font-semibold text-brand-400 border-b-2 border-brand-400'
                    : 'font-medium text-dim-300 hover:text-dim-50',
                )}
              >
                {it.num} / {it.label}
              </button>
            );
          })}
        </nav>

        {/* Contenido de la sección. */}
        {seccion === 'personas' ? <Personas />
          : seccion === 'pos' ? <PosLocal localId={localSel} locales={locales} />
          : seccion === 'roles' ? <Roles />
          : seccion === 'marcas' ? <Marcas />
          : seccion === 'audit' ? <Auditoria />
          : <MiCuenta email={sesion.email} />}
      </main>

      <footer className="p-6 border-t border-slate-900 bg-[#04060B] flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4 mono text-[10px] text-dim-300">
          <span className="text-brand-400 uppercase font-semibold">v.05-STABLE</span>
          <div className="w-1 h-1 rounded-full bg-slate-800" />
          <span>ENCRYPTED_LINK: ACTIVE</span>
          <div className="w-1 h-1 rounded-full bg-slate-800" />
          <span>ECOSISTEMA · PASE · COMANDA · MESA</span>
        </div>
        <div className="flex items-center gap-1 text-xs mono">
          <span className="text-dim-300 opacity-60">BUILT_BY</span>
          <span className="font-bold tracking-tight">accesos<span className="text-gold">.</span></span>
        </div>
      </footer>
    </div>
  );
}

// ─── Boot / Cargando ──────────────────────────────────────────────────────
function BootScreen() {
  return (
    <div className="min-h-screen grid place-items-center bg-carbon-900">
      <div className="scanline" />
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
          <span className="mono text-[10px] font-medium tracking-[0.2em] text-gold uppercase">Iniciando sistema</span>
        </div>
        <div className="mono text-3xl font-bold tracking-tight text-dim-50">
          accesos<span className="text-gold">.</span><span className="text-dim-300 font-light text-xl">os</span>
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
      <div className="scanline" />
      {/* Halo celeste sutil detrás de la tarjeta. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(117,170,219,0.10),transparent_60%)]" />

      <form onSubmit={onSubmit} className="relative w-full max-w-md">
        {/* Barra superior tipo consola. */}
        <div className="flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-dim-300 mb-2 px-1">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
            <span className="text-gold">System · Ready</span>
          </div>
          <span>ACCESOS.SYS</span>
        </div>

        <div className="bg-carbon-800 border border-carbon-600 rounded shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden">
          {/* Header: logo terminal. */}
          <div className="px-6 pt-6 pb-4 border-b border-carbon-600">
            <div className="mono flex items-baseline gap-2">
              <span className="text-brand-400 opacity-70">root@accesos:~#</span>
              <div className="text-2xl font-bold tracking-tight">
                accesos<span className="text-gold">.</span><span className="text-dim-300 font-light text-lg">os</span>
              </div>
            </div>
            <p className="text-sm text-dim-300 mt-2">Gestión de personas y accesos del ecosistema.</p>
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
            <button
              type="submit"
              disabled={entrando}
              className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-[3px] mono uppercase tracking-[0.2em] text-xs text-brand-300 border border-brand-400/20 hover:bg-brand-400/10 hover:text-brand-200 hover:border-brand-400/50 transition-all disabled:opacity-50"
            >
              {entrando ? 'Autenticando…' : 'Ejecutar ingreso'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          <div className="px-6 pb-4 flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-dim-400">
            <span>ECOSISTEMA COCINA</span>
            <span>PASE · COMANDA · MESA</span>
          </div>
        </div>
      </form>
    </div>
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
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded border border-carbon-600 bg-carbon-800 px-3 py-1.5 text-dim-100 hover:border-brand-400 hover:text-dim-50 max-w-[200px] transition-colors"
      >
        <MapPin className="h-4 w-4 text-brand-400 shrink-0" />
        <span className="truncate mono text-[10px] tracking-widest2 uppercase">{actual?.nombre ?? 'ELEGÍ LOCAL'}</span>
        <ChevronDown className={cn('h-4 w-4 text-dim-300 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-40 w-56 rounded border border-carbon-600 bg-carbon-800 shadow-[0_8px_40px_rgba(0,0,0,0.5)] py-1">
            {locales.map((l) => (
              <button
                key={l.id}
                onClick={() => { onSelect(l.id); setOpen(false); }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors',
                  l.id === sel
                    ? 'text-brand-300 bg-brand-400/10'
                    : 'text-dim-100 hover:bg-carbon-700',
                )}
              >
                <span className="truncate mono text-[10px] tracking-widest2 uppercase">{l.nombre}</span>
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
