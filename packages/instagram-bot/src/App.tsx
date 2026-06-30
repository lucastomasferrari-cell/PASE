// Web propia del bot de Instagram. Login (Supabase Auth, mismo del ecosistema
// Cocina) + la consola de mensajería (ver/responder DMs, config del bot). El
// backend del bot (webhook, /api/send) vive en este mismo proyecto Vercel.
//
// Quién puede VER: cualquier usuario autenticado del ecosistema (los datos ig_*
// ya están protegidos por RLS por tenant). Quién puede RESPONDER como humano:
// solo dueño/admin/superadmin — lo valida server-side /api/send.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LogOut, MessageCircle } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { Mensajeria } from '@/pages/Mensajeria';

export function App() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);

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

  if (!supabaseConfigurado) {
    return (
      <div className="min-h-screen grid place-items-center text-ink-muted px-6 text-center">
        Falta configurar el bot: agregá <code className="mx-1">VITE_SUPABASE_ANON_KEY</code> en Vercel.
      </div>
    );
  }
  if (cargando) return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={entrar} className="w-full max-w-md rounded-2xl bg-white border border-ink/5 shadow-card p-8 space-y-4">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="inline-grid place-items-center w-10 h-10 rounded-xl bg-brand-500 text-white"><MessageCircle className="h-5 w-5" /></span>
            <div className="leading-tight">
              <span className="text-lg font-medium text-brand-700 block">Bot de Instagram</span>
              <span className="text-xs text-ink-muted">misma cuenta que PASE</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="b-email" className="text-sm font-medium">Usuario o email</label>
            <input id="b-email" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="b-pass" className="text-sm font-medium">Contraseña</label>
            <input id="b-pass" type="password" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
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
    <div className="min-h-screen bg-crema flex flex-col">
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-ink/10 h-16 flex items-center gap-3 px-4 sm:px-6">
        <span className="inline-grid place-items-center w-8 h-8 rounded-lg bg-brand-500 text-white"><MessageCircle className="h-4 w-4" /></span>
        <h1 className="text-lg font-medium">Mensajería Instagram</h1>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden sm:block text-xs text-ink-muted truncate max-w-[180px]" title={sesion.email}>{sesion.email}</span>
          <button onClick={() => void salir()} className="text-ink-soft hover:text-ink inline-flex items-center gap-1.5 text-sm p-2 rounded-lg hover:bg-ink/5" title="Salir">
            <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>
      <main className="flex-1 px-3 sm:px-6 py-4 w-full max-w-6xl mx-auto">
        <Mensajeria userId={userId ?? 0} />
      </main>
    </div>
  );
}
