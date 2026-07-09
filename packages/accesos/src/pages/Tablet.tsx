// Tablet del local — genera/rota las credenciales del login del local
// (modelo PIN-first). La tablet queda logueada eternamente con este mail
// ficticio + password aleatoria; cada persona se identifica con su PIN.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Tablet as TabletIcon, RotateCw, Copy, Eye, EyeOff, Info } from 'lucide-react';
import { db } from '@/lib/supabase';

interface Props {
  localId: number | null;
  locales: { id: number; nombre: string }[];
}

interface LocalLogin {
  id: number;
  nombre: string;
  login_email: string | null;
  login_password_rotated_at: string | null;
}

interface Credenciales {
  email: string;
  password: string;
}

export function Tablet({ localId, locales }: Props) {
  const [local, setLocal] = useState<LocalLogin | null>(null);
  const [cargando, setCargando] = useState(false);
  const [rotando, setRotando] = useState(false);
  const [creds, setCreds] = useState<Credenciales | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);

  const reload = useCallback(async () => {
    if (!localId) { setLocal(null); return; }
    setCargando(true);
    const { data, error } = await db()
      .from('locales')
      .select('id, nombre, login_email, login_password_rotated_at')
      .eq('id', localId)
      .maybeSingle();
    if (error) toast.error(error.message);
    setLocal((data ?? null) as LocalLogin | null);
    setCargando(false);
  }, [localId]);

  useEffect(() => { void reload(); setCreds(null); setPasswordVisible(false); }, [reload]);

  async function rotarCredenciales() {
    if (!localId) return;
    if (local?.login_email) {
      const ok = window.confirm(
        'Rotar la contraseña de la tablet.\n\n'
        + '⚠️ La tablet actual va a quedar desconectada — hay que loguearla de nuevo con la contraseña nueva.\n\n'
        + '¿Continuar?',
      );
      if (!ok) return;
    }
    setRotando(true);
    const { data: sess } = await db().auth.getSession();
    const jwt = sess.session?.access_token;
    const res = await fetch('/api/auth-admin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt ?? ''}`,
      },
      body: JSON.stringify({ action: 'local_login_rotate', local_id: localId }),
    });
    const body = await res.json().catch(() => ({}));
    setRotando(false);
    if (!res.ok || !body.ok) {
      toast.error(body.error ?? 'No se pudo rotar');
      return;
    }
    setCreds({ email: body.email, password: body.password });
    setPasswordVisible(true);
    void reload();
    toast.success(local?.login_email ? 'Contraseña rotada' : 'Credenciales generadas');
  }

  function copiar(v: string) {
    navigator.clipboard.writeText(v).then(
      () => toast.success('Copiado'),
      () => toast.error('No se pudo copiar'),
    );
  }

  if (!localId && locales.length > 1) {
    return (
      <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3 max-w-3xl">
        Elegí un local en la barra superior.
      </div>
    );
  }

  if (cargando) return <div className="py-16 text-center text-ink-muted">Cargando…</div>;
  if (!local) return null;

  const yaExiste = !!local.login_email;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start gap-3 rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm text-ink-muted">
        <Info className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-ink">Cómo funciona el login de la tablet</p>
          <p className="mt-1 leading-relaxed">
            La tablet del local se loguea <strong>una sola vez</strong> con estas credenciales y queda eternamente logueada. Después,
            cada empleado se identifica con su <strong>PIN de 4 dígitos</strong> desde la sección "PIN del POS".
            Si la tablet se pierde o cambia de manos, <strong>rotá la contraseña</strong> — la tablet vieja se desconecta sola.
          </p>
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand/10 flex items-center justify-center text-brand">
            <TabletIcon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold">{local.nombre}</h3>
            <p className="text-xs text-ink-muted">
              {yaExiste
                ? `Credenciales activas · rotadas ${local.login_password_rotated_at
                    ? new Date(local.login_password_rotated_at).toLocaleString('es-AR')
                    : 'nunca'}`
                : 'Sin credenciales generadas todavía'}
            </p>
          </div>
        </div>

        {yaExiste && (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wider text-ink-muted font-semibold mb-1">Mail de la tablet</p>
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono flex-1 truncate">{local.login_email}@pase.local</code>
              <button
                type="button"
                onClick={() => copiar(`${local.login_email}@pase.local`)}
                className="p-1.5 hover:bg-slate-200 rounded"
                title="Copiar"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {creds && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 space-y-2">
            <p className="text-xs font-semibold text-emerald-800">
              ⚠️ Anotá la contraseña ahora — no se puede recuperar. Después solo se puede rotar (crea una nueva).
            </p>
            <div>
              <p className="text-xs uppercase tracking-wider text-emerald-700 font-semibold mb-1">Contraseña</p>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono flex-1 truncate">
                  {passwordVisible ? creds.password : '•'.repeat(creds.password.length)}
                </code>
                <button
                  type="button"
                  onClick={() => setPasswordVisible((v) => !v)}
                  className="p-1.5 hover:bg-emerald-100 rounded"
                  title={passwordVisible ? 'Ocultar' : 'Mostrar'}
                >
                  {passwordVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => copiar(creds.password)}
                  className="p-1.5 hover:bg-emerald-100 rounded"
                  title="Copiar"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => void rotarCredenciales()}
          disabled={rotando}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-60 font-medium transition-colors"
        >
          <RotateCw className={`h-4 w-4 ${rotando ? 'animate-spin' : ''}`} />
          {rotando ? 'Rotando…' : yaExiste ? 'Rotar contraseña' : 'Generar credenciales de la tablet'}
        </button>
      </div>
    </div>
  );
}
