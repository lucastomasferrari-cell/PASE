// Panel interno de MESA — /admin.
//
// HOY: login real contra el Supabase Auth compartido del ecosistema (mismas
// cuentas que PASE/COMANDA) + home placeholder. En el próximo sprint se portan
// acá la Agenda de reservas, Eventos y Giftcards (los services ya existen en
// COMANDA y la base es compartida — es mudanza, no re-construcción).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, LogOut } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);

  useEffect(() => {
    // 'sin config' se deriva en render — el effect solo resuelve la sesión async.
    if (!supabaseConfigurado) return;
    void (async () => {
      const { data } = await db().auth.getSession();
      if (data.session?.user?.email) setSesion({ email: data.session.user.email });
      setCargando(false);
    })();
  }, []);

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
    <div className="min-h-screen">
      <header className="container py-5 flex items-center justify-between">
        <span className="font-display text-xl font-semibold text-brand-600">mesa.</span>
        <button onClick={() => void salir()} className="text-sm text-ink-soft hover:text-ink flex items-center gap-1.5">
          <LogOut className="h-4 w-4" /> Salir
        </button>
      </header>
      <main className="container py-10">
        <p className="text-sm text-ink-muted">Conectado como {sesion.email}</p>
        <h1 className="font-display text-3xl font-semibold mt-2">Panel MESA</h1>
        <div className="mt-8 rounded-2xl bg-white border border-ink/5 shadow-sm p-6 max-w-xl">
          <p className="font-medium flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-brand-500" /> Agenda · Eventos · Giftcards
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            Se mudan acá desde COMANDA en el próximo sprint. Mientras tanto, la
            gestión vive en COMANDA → Reservas y COMANDA → Marketing → Eventos
            y Giftcards.
          </p>
        </div>
      </main>
    </div>
  );
}
