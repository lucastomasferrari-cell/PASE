// Accesos por app — matriz usuario × app. De un vistazo ves quién puede
// entrar a cada app del ecosistema y editás con un toque. Es la lectura
// rápida de Personas: misma data, vista cruzada.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink } from 'lucide-react';
import { listUsuarios, actualizarUsuario, type Usuario } from '@/lib/usuariosService';
import { APPS, type AppKey } from '@/lib/apps';

function nombre(u: Usuario) { return u.nombre || u.email; }

export function Accesos() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listUsuarios();
    if (error) toast.error(error);
    setUsuarios(data.filter((u) => u.activo).sort((a, b) => nombre(a).localeCompare(nombre(b))));
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(u: Usuario, k: AppKey) {
    const apps = u.apps_permitidas ?? ['pase'];
    const nuevos = apps.includes(k) ? apps.filter((x) => x !== k) : [...apps, k];
    setUsuarios((prev) => prev.map((x) => x.id === u.id ? { ...x, apps_permitidas: nuevos } : x));
    const { error } = await actualizarUsuario(u.id, { apps_permitidas: nuevos });
    if (error) { toast.error(error); void reload(); }
  }

  if (cargando) return <div className="py-16 text-center text-ink-muted">Cargando matriz…</div>;

  return (
    <div className="space-y-4 max-w-5xl">
      <p className="text-sm text-ink-muted">Marcá o desmarcá las apps a las que cada persona del equipo puede entrar. Los cambios se aplican al instante.</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {APPS.map((a) => (
          <div key={a.key} className="rounded-2xl bg-white border border-ink/5 shadow-card p-3 flex items-start gap-2">
            <span className="text-2xl">{a.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium">{a.nombre}</div>
              <div className="text-[11px] text-ink-muted">{a.paraQuien}</div>
            </div>
            {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-ink-muted hover:text-brand-600 shrink-0"><ExternalLink className="h-3.5 w-3.5" /></a>}
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-brand-50/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-ink-soft">Persona</th>
                {APPS.map((a) => (
                  <th key={a.key} className="px-2 py-3 font-medium text-ink-soft text-center w-20">{a.emoji}<div className="text-[11px] mt-0.5">{a.nombre}</div></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => {
                const apps = u.apps_permitidas ?? ['pase'];
                return (
                  <tr key={u.id} className="border-t border-ink/5">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{nombre(u)}</div>
                      <div className="text-[11px] text-ink-muted">{u.rol}</div>
                    </td>
                    {APPS.map((a) => {
                      const sel = apps.includes(a.key);
                      return (
                        <td key={a.key} className="text-center">
                          <button onClick={() => void toggle(u, a.key)}
                                  className={`w-7 h-7 rounded-md border inline-flex items-center justify-center ${sel ? 'bg-brand-500 border-brand-500 text-white' : 'bg-white border-ink/15 text-ink-muted hover:border-brand-300'}`}>
                            {sel && <Check className="h-4 w-4" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
