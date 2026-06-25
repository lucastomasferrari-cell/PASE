// Habitué — panel del CRM. Login (Supabase Auth compartido) + sidebar de
// secciones. Comensales funciona end-to-end; Segmentos / Campañas / Fidelidad /
// Cupones quedan como próximos sprints (placeholder con el plan).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LogOut, Users, Filter, Megaphone, Award, Ticket } from 'lucide-react';
import { db, supabaseConfigurado } from '@/lib/supabase';
import { Comensales } from './Comensales';

type Seccion = 'comensales' | 'segmentos' | 'campanas' | 'fidelidad' | 'cupones';

const NAV: { key: Seccion; label: string; icon: React.ReactNode; pronto?: boolean }[] = [
  { key: 'comensales', label: 'Comensales', icon: <Users className="h-[18px] w-[18px]" /> },
  { key: 'segmentos', label: 'Segmentos', icon: <Filter className="h-[18px] w-[18px]" />, pronto: true },
  { key: 'campanas', label: 'Campañas', icon: <Megaphone className="h-[18px] w-[18px]" />, pronto: true },
  { key: 'fidelidad', label: 'Fidelidad', icon: <Award className="h-[18px] w-[18px]" />, pronto: true },
  { key: 'cupones', label: 'Cupones', icon: <Ticket className="h-[18px] w-[18px]" />, pronto: true },
];

const PRONTO: Record<string, { titulo: string; desc: string }> = {
  segmentos: { titulo: 'Segmentos inteligentes', desc: 'Agrupá comensales por comportamiento (los que no vienen hace 30 días, VIP, los que más gastan) para accionar sobre cada grupo.' },
  campanas: { titulo: 'Campañas', desc: 'Mandá WhatsApp o email a un segmento — promos, "te extrañamos", cumpleaños — y medí quién volvió.' },
  fidelidad: { titulo: 'Fidelidad', desc: 'Puntos por visita/consumo, niveles y premios para convertir comensales en habitués.' },
  cupones: { titulo: 'Cupones y promos', desc: 'Creá códigos de descuento, seguilos y canjealos en COMANDA.' },
};

export function AdminHome() {
  const [sesion, setSesion] = useState<{ email: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [entrando, setEntrando] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [seccion, setSeccion] = useState<Seccion>('comensales');

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
      const { data } = await db().from('comanda_local_settings').select('tenant_id').is('deleted_at', null).limit(1).maybeSingle();
      if (data?.tenant_id) setTenantId(data.tenant_id as string);
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
    setSesion(null); setTenantId(null);
  }

  if (!supabaseConfigurado) {
    return <div className="min-h-screen grid place-items-center text-ink-muted">Habitué sin configurar (env vars).</div>;
  }
  if (cargando) return <div className="min-h-screen grid place-items-center text-ink-muted">Cargando…</div>;

  if (!sesion) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={entrar} className="w-full max-w-sm rounded-2xl bg-white border border-ink/5 shadow-card p-6 space-y-4">
          <div>
            <span className="font-display text-2xl font-semibold text-brand-600">habitué<span className="text-brand-400">.</span></span>
            <p className="text-sm text-ink-muted mt-1">CRM y marketing — misma cuenta que PASE/COMANDA/MESA.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="h-email" className="text-sm font-medium">Usuario o email</label>
            <input id="h-email" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="h-pass" className="text-sm font-medium">Contraseña</label>
            <input id="h-pass" type="password" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
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
          <span className="font-display text-2xl font-semibold text-brand-600">habitué<span className="text-brand-400">.</span></span>
        </div>
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          {NAV.map((it) => (
            <button key={it.key} onClick={() => setSeccion(it.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      seccion === it.key ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-ink/5'
                    }`}>
              {it.icon}<span className="flex-1 text-left">{it.label}</span>
              {it.pronto && <span className="text-[10px] text-ink-muted">pronto</span>}
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
          <span className="md:hidden font-display text-xl font-semibold text-brand-600">habitué<span className="text-brand-400">.</span></span>
          <h1 className="font-display text-lg font-semibold capitalize">{NAV.find((n) => n.key === seccion)?.label}</h1>
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
          {seccion === 'comensales' ? (
            <Comensales tenantId={tenantId ?? ''} />
          ) : (
            <div className="max-w-md mx-auto mt-10 rounded-2xl bg-white border border-ink/5 shadow-card p-8 text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3">
                {NAV.find((n) => n.key === seccion)?.icon}
              </div>
              <h2 className="font-display text-xl font-semibold">{PRONTO[seccion]?.titulo}</h2>
              <p className="text-sm text-ink-muted mt-2">{PRONTO[seccion]?.desc}</p>
              <p className="text-xs text-brand-600 mt-4 font-medium">Próximo sprint</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
