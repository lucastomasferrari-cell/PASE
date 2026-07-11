// Tablet del local — genera/rota las credenciales del login del local
// (modelo PIN-first). La tablet queda logueada eternamente con este mail
// ficticio + password aleatoria; cada persona se identifica con su PIN.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Tablet as TabletIcon, Copy, Eye, EyeOff, Info } from 'lucide-react';
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
  const [passElegida, setPassElegida] = useState('');

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

  async function rotarCredenciales(chosenPassword?: string) {
    if (!localId) return;
    if (local?.login_email) {
      const ok = window.confirm(
        (chosenPassword ? 'Cambiar la contraseña de la tablet.' : 'Rotar la contraseña de la tablet.') + '\n\n'
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
      body: JSON.stringify({ action: 'local_login_rotate', local_id: localId, ...(chosenPassword ? { password: chosenPassword } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    setRotando(false);
    if (!res.ok || !body.ok) {
      toast.error(body.error ?? 'No se pudo actualizar');
      return;
    }
    setCreds({ email: body.email, password: body.password });
    setPasswordVisible(true);
    setPassElegida('');
    void reload();
    toast.success(local?.login_email ? 'Contraseña actualizada' : 'Credenciales generadas');
  }

  function usarElegida() {
    if (passElegida.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return; }
    void rotarCredenciales(passElegida);
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
      <div className="flex items-start gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-ink-muted">
        <Info className="h-3.5 w-3.5 text-slate-500 shrink-0 mt-0.5" />
        <p>La tablet entra una vez con esta cuenta y queda logueada; después cada empleado usa su <strong>PIN</strong>. Si se pierde, rotá la contraseña y la vieja se desconecta.</p>
      </div>

      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700">
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

        <div>
          <p className="text-xs text-ink-muted mb-2">
            {yaExiste
              ? <>La contraseña actual <strong>no se puede ver</strong> (se guarda encriptada). Poné una nueva:</>
              : 'Poné una contraseña para la tablet:'}
          </p>
          <div className="flex gap-2">
            <input
              value={passElegida}
              onChange={(e) => setPassElegida(e.target.value)}
              placeholder="Contraseña de la tablet (mín. 8)"
              className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void usarElegida()}
              disabled={rotando || passElegida.length < 8}
              className="px-4 py-2 rounded-lg bg-brand-500 text-white hover:bg-brand-600 text-sm font-medium disabled:opacity-50 shrink-0"
            >
              {rotando ? 'Guardando…' : yaExiste ? 'Cambiar' : 'Generar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
