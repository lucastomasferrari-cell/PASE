// Tablet del local — genera/rota las credenciales del login del local
// (modelo PIN-first). La tablet queda logueada eternamente con este mail
// ficticio + password aleatoria; cada persona se identifica con su PIN.
//
// Look Command Center (17-jul): sin cajas contenedoras. La sección tiene su
// header en PosLocal; acá viene directo la nota + fila del dispositivo, con
// hairlines como separador.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Tablet as TabletIcon, Copy, Eye, EyeOff, Info } from 'lucide-react';
import { db } from '@/lib/supabase';
import { MiniNote } from '@/components/primitives';

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
      <MiniNote tone="warn">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>Elegí un local en la barra superior.</span>
      </MiniNote>
    );
  }

  if (cargando) return <div className="py-8 text-center text-dim-300 font-mono text-xs uppercase tracking-widest2">Cargando…</div>;
  if (!local) return null;

  const yaExiste = !!local.login_email;

  return (
    <div>
      <MiniNote tone="brand">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div>
          La tablet entra una vez con esta cuenta y queda logueada; después cada empleado usa su{' '}
          <strong className="font-mono text-[11px] text-brand-300 tracking-widest2">PIN</strong>.
          Si se pierde, rotá la contraseña y la vieja se desconecta.
        </div>
      </MiniNote>

      {/* Fila del dispositivo — sin caja, sin border interno. */}
      <div className="py-4">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-sm bg-carbon-700/60 flex items-center justify-center text-brand-300 shrink-0">
            <TabletIcon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-[15px] font-medium text-dim-50">{local.nombre}</h3>
              {yaExiste ? (
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-live">ACTIVA</span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-dim-400">SIN CREDENCIAL</span>
              )}
            </div>
            <p className="text-xs text-dim-400 mt-1 font-mono">
              {yaExiste
                ? `ROTADA ${local.login_password_rotated_at
                    ? new Date(local.login_password_rotated_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).toUpperCase()
                    : 'NUNCA'}`
                : 'AÚN NO SE GENERÓ CONTRASEÑA PARA ESTA TABLET.'}
            </p>
          </div>
        </div>

        {/* Mail actual + form nueva contraseña, alineados al bloque de contenido. */}
        <div className="pl-[54px] space-y-3 mt-4">
          {yaExiste && (
            <div>
              <p className="label-sys mb-1.5">Mail de la tablet</p>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono flex-1 truncate text-dim-100">{local.login_email}@pase.local</code>
                <button
                  type="button"
                  onClick={() => copiar(`${local.login_email}@pase.local`)}
                  className="h-7 w-7 rounded-sm border-b border-carbon-600 text-dim-300 hover:text-dim-50 hover:border-carbon-500 hover:bg-carbon-700 inline-flex items-center justify-center"
                  title="Copiar"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {creds && (
            <div className="border-l-2 border-l-live bg-live/[0.04] px-3.5 py-3 space-y-2">
              <p className="text-xs text-live font-mono uppercase tracking-widest2">
                ⚠ Anotá la contraseña ahora — no se puede recuperar. Después solo se puede rotar.
              </p>
              <div>
                <p className="label-sys mb-1">Contraseña</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono flex-1 truncate text-dim-50">
                    {passwordVisible ? creds.password : '•'.repeat(creds.password.length)}
                  </code>
                  <button
                    type="button"
                    onClick={() => setPasswordVisible((v) => !v)}
                    className="h-7 w-7 rounded-sm border-b border-carbon-600 text-dim-300 hover:text-dim-50 hover:bg-carbon-700 inline-flex items-center justify-center"
                    title={passwordVisible ? 'Ocultar' : 'Mostrar'}
                  >
                    {passwordVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => copiar(creds.password)}
                    className="h-7 w-7 rounded-sm border-b border-carbon-600 text-dim-300 hover:text-dim-50 hover:bg-carbon-700 inline-flex items-center justify-center"
                    title="Copiar"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div>
            <p className="label-sys mb-1.5">
              {yaExiste ? 'Cambiar contraseña' : 'Nueva contraseña'}
            </p>
            <div className="flex gap-3 items-center">
              <input
                value={passElegida}
                onChange={(e) => setPassElegida(e.target.value)}
                placeholder="Contraseña de la tablet (mín. 8)…"
                className="flex-1 h-8 bg-transparent px-1 text-sm font-mono text-dim-50 placeholder:text-dim-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void usarElegida()}
                disabled={rotando || passElegida.length < 8}
                className="text-brand-300 hover:text-brand-200 font-mono uppercase tracking-widest2 text-xs disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
              >
                {rotando ? 'GUARDANDO…' : yaExiste ? 'CAMBIAR →' : 'GENERAR →'}
              </button>
            </div>
            {yaExiste && (
              <p className="text-[11px] text-dim-400 mt-1.5">
                La contraseña actual no se puede ver (se guarda encriptada).
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
