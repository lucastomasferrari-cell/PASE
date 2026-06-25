// Personas — alma del admin: lista, alta, edición y baja de usuarios del
// tenant. Cada uno con su rol, apps permitidas, locales asignados y permisos.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search, Plus, X, Check, Power, KeyRound, ShieldCheck, MapPin } from 'lucide-react';
import {
  listUsuarios, crearUsuario, actualizarUsuario, setPermisos, setLocales,
  resetPassword, listLocales, type Usuario,
} from '@/lib/usuariosService';
import { APPS, type AppKey } from '@/lib/apps';
import { CATEGORIAS } from '@/lib/permisos';

const ROLES_BASE = ['dueno', 'admin', 'encargado', 'cajero', 'compras'];

function nombre(u: Usuario) { return u.nombre || u.email; }

export function Personas() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [locales, setLocs] = useState<{ id: number; nombre: string }[]>([]);
  const [search, setSearch] = useState('');
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<Usuario | 'nuevo' | null>(null);

  const reload = useCallback(async () => {
    setCargando(true);
    const [u, l] = await Promise.all([listUsuarios(), listLocales()]);
    if (u.error) toast.error('No se pudieron cargar usuarios: ' + u.error);
    setUsuarios(u.data); setLocs(l.data);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtrados = usuarios.filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (u.nombre ?? '').toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q);
  });

  async function toggleActivo(u: Usuario) {
    setUsuarios((prev) => prev.map((x) => x.id === u.id ? { ...x, activo: !x.activo } : x));
    const { error } = await actualizarUsuario(u.id, { activo: !u.activo });
    if (error) { toast.error(error); void reload(); }
    else toast.success(`${nombre(u)} ${!u.activo ? 'activado' : 'desactivado'}`);
  }

  async function reset(u: Usuario) {
    if (!window.confirm(`¿Resetear la contraseña de ${nombre(u)}?`)) return;
    const { error, tempPassword } = await resetPassword(u.id);
    if (error) { toast.error(error); return; }
    if (tempPassword) {
      window.prompt('Pasale esta contraseña temporal — la cambia al loguearse:', tempPassword);
    } else toast.success('Contraseña reseteada');
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre o email…"
                 className="w-full rounded-lg border border-ink/15 bg-white pl-9 pr-3 py-2.5 text-sm" />
        </div>
        <button onClick={() => setEditando('nuevo')}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2.5 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Nueva persona
        </button>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando equipo…</div>
      ) : filtrados.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">Sin resultados</p>
          <p className="text-sm text-ink-muted mt-1">Probá otra búsqueda o cargá una persona nueva.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtrados.map((u) => (
            <UsuarioCard key={u.id} u={u} locales={locales} onEditar={() => setEditando(u)}
                         onToggleActivo={() => void toggleActivo(u)} onReset={() => void reset(u)} />
          ))}
        </div>
      )}

      {editando && (
        <FormUsuario
          usuario={editando === 'nuevo' ? null : editando}
          locales={locales}
          onClose={() => setEditando(null)}
          onSaved={() => { setEditando(null); void reload(); }}
        />
      )}
    </div>
  );
}

function UsuarioCard({ u, locales, onEditar, onToggleActivo, onReset }: {
  u: Usuario; locales: { id: number; nombre: string }[]; onEditar: () => void; onToggleActivo: () => void; onReset: () => void;
}) {
  const apps = u.apps_permitidas ?? ['pase'];
  const locsAsignados = (u.locales ?? []).map((id) => locales.find((l) => l.id === id)?.nombre).filter(Boolean);

  return (
    <div className={`rounded-2xl bg-white border shadow-card p-4 ${u.activo ? 'border-ink/5' : 'border-ink/5 opacity-60'}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
          {(nombre(u)[0] ?? '?').toUpperCase()}
        </div>
        <div className="flex-1 min-w-[160px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{nombre(u)}</span>
            <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">{u.rol}</span>
            {u.password_temporal && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Password temporal</span>}
            {!u.activo && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">Inactivo</span>}
          </div>
          <div className="text-xs text-ink-muted mt-0.5">{u.email}</div>
          <div className="flex flex-wrap gap-1 mt-2">
            {apps.map((k) => {
              const app = APPS.find((a) => a.key === (k as AppKey));
              return (
                <span key={k} className="text-[11px] px-2 py-0.5 rounded-full bg-brand-100 text-brand-800 border border-brand-200 inline-flex items-center gap-1">
                  {app?.emoji} {app?.nombre ?? k}
                </span>
              );
            })}
          </div>
          {locsAsignados.length > 0 && (
            <div className="text-[11px] text-ink-muted mt-1 inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{locsAsignados.join(' · ')}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onEditar} className="text-xs px-2.5 py-1.5 rounded-lg border border-brand-200 bg-white hover:bg-brand-50 text-brand-700 font-medium inline-flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> Editar
          </button>
          <button onClick={onReset} className="text-xs px-2.5 py-1.5 rounded-lg border border-ink/15 bg-white hover:bg-ink/5 text-ink-soft font-medium inline-flex items-center gap-1" title="Resetear contraseña">
            <KeyRound className="h-3.5 w-3.5" />
          </button>
          <button onClick={onToggleActivo} title={u.activo ? 'Desactivar' : 'Activar'}
                  className={`p-2 rounded-lg border ${u.activo ? 'border-amber-200 text-amber-700 hover:bg-amber-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}>
            <Power className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function FormUsuario({ usuario, locales, onClose, onSaved }: {
  usuario: Usuario | null;
  locales: { id: number; nombre: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const esEdicion = usuario !== null;
  const [nombreT, setNombre] = useState(usuario?.nombre ?? '');
  const [email, setEmail] = useState(usuario?.email ?? '');
  const [rol, setRol] = useState(usuario?.rol ?? 'encargado');
  const [password, setPassword] = useState('');
  const [apps, setApps] = useState<string[]>(usuario?.apps_permitidas ?? ['pase']);
  const [locs, setLocs] = useState<number[]>(usuario?.locales ?? []);
  const [permisos, setPermisosState] = useState<string[]>(usuario?.permisos ?? []);
  const [guardando, setGuardando] = useState(false);

  function toggleApp(k: string) { setApps((a) => a.includes(k) ? a.filter((x) => x !== k) : [...a, k]); }
  function toggleLocal(id: number) { setLocs((l) => l.includes(id) ? l.filter((x) => x !== id) : [...l, id]); }
  function togglePerm(slug: string) { setPermisosState((p) => p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]); }

  async function guardar() {
    if (!nombreT.trim()) { toast.error('Falta el nombre'); return; }
    if (!email.trim()) { toast.error('Falta el email'); return; }
    if (!esEdicion && (!password || password.length < 6)) { toast.error('La password inicial debe tener al menos 6 caracteres'); return; }
    setGuardando(true);
    try {
      let id: number;
      if (esEdicion && usuario) {
        const upd = await actualizarUsuario(usuario.id, {
          nombre: nombreT.trim(), rol, apps_permitidas: apps,
        });
        if (upd.error) { toast.error(upd.error); return; }
        id = usuario.id;
      } else {
        const { id: nuevoId, error } = await crearUsuario({
          email: email.trim(), nombre: nombreT.trim(), rol, password, apps_permitidas: apps,
        });
        if (error || !nuevoId) { toast.error(error ?? 'No se pudo crear'); return; }
        id = nuevoId;
      }
      const [pe, lo] = await Promise.all([setPermisos(id, permisos), setLocales(id, locs)]);
      if (pe.error) { toast.error('Usuario guardado pero falló permisos: ' + pe.error); return; }
      if (lo.error) { toast.error('Usuario guardado pero falló locales: ' + lo.error); return; }
      toast.success(esEdicion ? 'Usuario actualizado' : 'Usuario creado');
      onSaved();
    } finally { setGuardando(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl font-semibold">{esEdicion ? `Editar a ${usuario?.nombre || usuario?.email}` : 'Nueva persona'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>

        <section className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Datos básicos</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">Nombre *</label>
              <input value={nombreT} onChange={(e) => setNombre(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">Email *</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" disabled={esEdicion}
                     className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm disabled:bg-ink/5" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">Rol</label>
              <select value={rol} onChange={(e) => setRol(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
                {ROLES_BASE.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            {!esEdicion && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-soft">Contraseña inicial *</label>
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Apps a las que puede entrar</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {APPS.map((a) => {
              const sel = apps.includes(a.key);
              return (
                <button key={a.key} onClick={() => toggleApp(a.key)} type="button"
                        className={`text-left rounded-xl border p-3 transition-colors ${sel ? 'border-brand-500 bg-brand-50/60' : 'border-ink/10 bg-white hover:bg-ink/5'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xl">{a.emoji}</span>
                    {sel && <Check className="h-4 w-4 text-brand-600" />}
                  </div>
                  <div className="font-medium mt-1">{a.nombre}</div>
                  <div className="text-[11px] text-ink-muted">{a.paraQuien}</div>
                </button>
              );
            })}
          </div>
        </section>

        {locales.length > 0 && (
          <section className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-ink-muted">Locales asignados (vacío = todos)</p>
            <div className="flex flex-wrap gap-1.5">
              {locales.map((l) => (
                <button key={l.id} onClick={() => toggleLocal(l.id)} type="button"
                        className={`text-xs px-3 py-1.5 rounded-full border ${locs.includes(l.id) ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink/15 text-ink-soft'}`}>
                  {l.nombre}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Permisos detallados</p>
          {CATEGORIAS.map((cat) => (
            <div key={cat.titulo} className="rounded-xl border border-ink/10 p-3">
              <p className="text-sm font-medium mb-2">{cat.emoji} {cat.titulo}</p>
              <div className="flex flex-wrap gap-1.5">
                {cat.permisos.map((p) => (
                  <button key={p.slug} type="button" onClick={() => togglePerm(p.slug)} title={p.descripcion}
                          className={`text-xs px-2.5 py-1 rounded-full border ${permisos.includes(p.slug) ? 'bg-brand-100 text-brand-800 border-brand-300' : 'bg-white text-ink-soft border-ink/15'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void guardar()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear persona'}
          </button>
        </div>
      </div>
    </div>
  );
}
