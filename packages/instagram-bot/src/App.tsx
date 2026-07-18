// Web propia del bot de Instagram. Login (Supabase Auth, mismo del ecosistema
// Cocina) + la consola de mensajería (ver/responder DMs, config del bot). El
// backend del bot (webhook, /api/send) vive en este mismo proyecto Vercel.
//
// Shell "Cocina.OS" (17-jul-2026): dark command center — status bar con dot
// dorado "System Live" + OPERATOR + reloj vivo + notificaciones + logout;
// scanline CRT; login estilo terminal. Fuente de verdad del look:
// PASE/cocina/index.html.
//
// Quién puede VER: cualquier usuario autenticado del ecosistema (los datos ig_*
// ya están protegidos por RLS por tenant). Quién puede RESPONDER como humano:
// solo dueño/admin/superadmin — lo valida server-side /api/send.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LogOut, Bell, BellOff, Shield, RefreshCw, ArrowRight } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { Mensajeria } from '@/pages/Mensajeria';
import { getPushPermissionStatus, isCurrentlySubscribed, subscribeToPush, unsubscribeFromPush } from '@/lib/push';

function nowHHMMSS(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function App() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushToggling, setPushToggling] = useState(false);
  const [horaLive, setHoraLive] = useState<string>(() => nowHHMMSS());

  useEffect(() => {
    const id = window.setInterval(() => setHoraLive(nowHHMMSS()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!supabaseConfigurado) { setCargando(false); return; }
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) setSesion({ email: data.session.user.email });
      setCargando(false);
    })();
    // Mantener la sesión en sync con refrescos de token / cambios. Sin esto, la
    // app solo miraba la sesión una vez y "se cerraba" sola al expirar el token.
    const { data: sub } = db().auth.onAuthStateChange((_event, session) => {
      setSesion(session?.user?.email ? { email: session.user.email } : null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && e.data.url) {
        window.location.href = e.data.url;
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!sesion) return;
    void (async () => {
      // El usuario interno se resuelve por auth_id, NO por email: la convención
      // del ecosistema guarda usuarios.email SIN @ (ej "dueno"), mientras el
      // email de Supabase Auth es "dueno@pase.local". Buscar por email no
      // matchea → userId quedaba en 0 → FK violation (tomada_por → usuarios.id)
      // al "Tomar como humano".
      const { data: sess } = await db().auth.getSession();
      const authId = sess.session?.user?.id;
      if (!authId) return;
      const { data } = await db().from('usuarios').select('id').eq('auth_id', authId).maybeSingle();
      if (data?.id) setUserId(data.id as number);
    })();
  }, [sesion]);

  useEffect(() => {
    if (!sesion) return;
    void isCurrentlySubscribed().then(setPushOn);
  }, [sesion]);

  async function togglePush() {
    setPushToggling(true);
    try {
      if (pushOn) {
        const r = await unsubscribeFromPush();
        if (r.ok) { setPushOn(false); toast.success('Notificaciones desactivadas'); }
        else toast.error(r.error);
      } else {
        const r = await subscribeToPush();
        if (r.ok) { setPushOn(true); toast.success('Notificaciones activadas'); }
        else toast.error(r.error);
      }
    } finally { setPushToggling(false); }
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
    setSesion(null); setUserId(null);
  }

  const operator = useMemo(() => {
    const base = (sesion?.email ?? '').split('@')[0] ?? '';
    return base ? base.toUpperCase() : 'OPERATOR';
  }, [sesion]);

  // ─── Estados de arranque / sin sesión ─────────────────────────────────────
  if (!supabaseConfigurado) {
    return (
      <div className="min-h-screen grid place-items-center bg-carbon-900 text-dim-300 px-6 text-center mono text-sm">
        Falta configurar el bot: agregá <code className="mx-1 text-brand-400">VITE_SUPABASE_ANON_KEY</code> en Vercel.
      </div>
    );
  }
  if (cargando) {
    return (
      <div className="min-h-screen grid place-items-center bg-carbon-900">
        <div className="scanline" />
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
            <span className="mono text-[10px] font-medium tracking-[0.2em] text-gold uppercase">Iniciando sistema</span>
          </div>
          <div className="mono text-3xl font-bold tracking-tight text-dim-50">
            instabot<span className="text-gold">.</span><span className="text-dim-300 font-light text-xl">os</span>
          </div>
        </div>
      </div>
    );
  }

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-4 bg-carbon-900 relative overflow-hidden">
        <div className="scanline" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(117,170,219,0.10),transparent_60%)]" />

        <form onSubmit={entrar} className="relative w-full max-w-md">
          <div className="flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-dim-300 mb-2 px-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
              <span className="text-gold">System · Ready</span>
            </div>
            <span>INSTABOT.SYS</span>
          </div>

          <div className="bg-carbon-800 border border-carbon-600 rounded shadow-card overflow-hidden">
            <div className="px-6 pt-6 pb-4 border-b border-carbon-600">
              <div className="mono flex items-baseline gap-2">
                <span className="text-brand-400 opacity-70">root@bot:~#</span>
                <div className="text-2xl font-bold tracking-tight">
                  instabot<span className="text-gold">.</span><span className="text-dim-300 font-light text-lg">os</span>
                </div>
              </div>
              <p className="text-sm text-dim-300 mt-2">Consola del bot de Instagram · misma cuenta que PASE.</p>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label htmlFor="b-email" className="label-sys block mb-1.5">Usuario o email</label>
                <input id="b-email" className="w-full h-10 px-3 mono text-sm text-dim-50 placeholder:text-dim-400" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dueno@empresa.com" autoFocus />
              </div>
              <div>
                <label htmlFor="b-pass" className="label-sys block mb-1.5">Contraseña</label>
                <input id="b-pass" type="password" className="w-full h-10 px-3 mono text-sm text-dim-50 placeholder:text-dim-400" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              <button type="submit" disabled={entrando}
                      className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-[3px] mono uppercase tracking-[0.2em] text-xs text-brand-300 border border-brand-400/20 hover:bg-brand-400/10 hover:text-brand-200 hover:border-brand-400/50 transition-all disabled:opacity-50">
                {entrando ? 'Autenticando…' : 'Ejecutar ingreso'}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 pb-4 flex items-center justify-between mono text-[10px] uppercase tracking-[0.2em] text-dim-400">
              <span>ECOSISTEMA COCINA</span>
              <span>BOT · IG.DM</span>
            </div>
          </div>
        </form>
      </div>
    );
  }

  // ─── App shell logueada ────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-carbon-900 overflow-hidden">
      <div className="scanline" />

      <nav className="status-bar sticky top-0 z-40 px-4 sm:px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gold glow-dot animate-pulse" />
            <span className="mono text-[10px] font-medium tracking-[0.2em] text-gold uppercase">System Live</span>
          </div>
          <div className="hidden md:flex gap-4 mono text-[10px] text-dim-300">
            <span className="flex items-center gap-1.5"><Shield className="h-3 w-3 text-brand-400" /> SECURITY: ENCRYPTED</span>
            <span className="flex items-center gap-1.5"><RefreshCw className="h-3 w-3" /> SYNC: OK</span>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="mono text-[10px] text-dim-300 hidden sm:block" title={sesion.email}>
            OPERATOR: <span className="text-brand-400">{operator}</span>
          </span>
          <div className="h-4 w-px bg-slate-800" />
          {getPushPermissionStatus() !== 'unsupported' && (
            <button
              onClick={() => void togglePush()}
              disabled={pushToggling}
              className={`transition-colors ${pushOn ? 'text-brand-400' : 'text-dim-300 hover:text-brand-400'}`}
              title={pushOn ? 'Desactivar notificaciones' : 'Activar notificaciones'}
            >
              {pushOn ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
          )}
          <button onClick={() => void salir()} className="text-dim-300 hover:text-crit inline-flex items-center gap-1.5 transition-colors" title="Salir">
            <LogOut className="h-4 w-4" /> <span className="mono text-[10px] hidden lg:inline">TERMINATE</span>
          </button>
          <div className="h-4 w-px bg-slate-800" />
          <span className="mono text-[11px] font-medium tabular-nums">{horaLive}</span>
        </div>
      </nav>

      <main className="flex-1 min-h-0 w-full max-w-[1200px] mx-auto px-3 sm:px-6 py-4 flex flex-col">
        <Mensajeria userId={userId ?? 0} />
      </main>
    </div>
  );
}
