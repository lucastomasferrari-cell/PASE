// Personas — alma del admin: lista, alta, edición y baja de usuarios del
// tenant. Cada uno con su credencial, apps, locales y permisos.
//
// Ficha con ACORDEÓN por app (Fase 1, 15-jul): todo colapsable y cerrado por
// defecto. Credenciales arriba (email + resetear contraseña). Luego "Datos
// básicos" y una barra por app; al abrir cada app se ven sus locales y permisos.
// PASE usa el modelo real (usuario_locales + usuario_permisos). Los locales de
// COMANDA/MESA/Habitué se guardan en usuarios.accesos_por_app (enforcement por
// app en fases siguientes). Los permisos de esas apps: próximamente.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Search, Plus, Check, Power, KeyRound, ShieldCheck, MapPin, ArrowLeft, Lock,
  ChevronDown, Copy, User as UserIcon,
} from 'lucide-react';
import {
  listUsuarios, crearUsuario, actualizarUsuario, sincronizarUsuario,
  resetPassword, listLocales, type Usuario,
} from '@/lib/usuariosService';
import { listRoles, type Rol } from '@/lib/rolesService';
import { logAudit } from '@/lib/auditService';
import { listMarcas, listLocalesConMarca } from '@/lib/marcasService';
import { APPS, type AppKey } from '@/lib/apps';
import { catalogoPermisosApp } from '@/lib/permisosApps';
import { Accesos } from './Accesos';

interface MarcaConLocales { id: number; nombre: string; localIds: number[] }
type LocalSimple = { id: number; nombre: string };

// Apps que operan por local (muestran selector de locales). Instagram y Accesos
// son a nivel tenant → no piden locales.
const APPS_CON_LOCALES = new Set<AppKey>(['pase', 'comanda', 'mesa', 'habitue']);

function nombre(u: Usuario) { return u.nombre || u.email; }

export function Personas() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [locales, setLocs] = useState<LocalSimple[]>([]);
  const [marcas, setMarcas] = useState<MarcaConLocales[]>([]);
  const [roles, setRoles] = useState<Rol[]>([]);
  const [search, setSearch] = useState('');
  const [cargando, setCargando] = useState(true);
  const [modo, setModo] = useState<'lista' | 'matriz'>('lista');
  const [editando, setEditando] = useState<Usuario | 'nuevo' | null>(null);

  const reload = useCallback(async () => {
    setCargando(true);
    const [u, l, m, lcm, r] = await Promise.all([listUsuarios(), listLocales(), listMarcas(), listLocalesConMarca(), listRoles()]);
    if (u.error) toast.error('No se pudieron cargar usuarios: ' + u.error);
    setUsuarios(u.data); setLocs(l.data); setRoles(r.data);
    setMarcas(m.data.map((mk) => ({
      id: mk.id,
      nombre: mk.nombre,
      localIds: lcm.data.filter((x) => x.marca_id === mk.id).map((x) => x.id),
    })).filter((mk) => mk.localIds.length > 0));
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
    else {
      toast.success(`${nombre(u)} ${!u.activo ? 'activado' : 'desactivado'}`);
      void logAudit({ usuarioId: u.id, accion: !u.activo ? 'activar' : 'desactivar' });
    }
  }

  async function reset(u: Usuario): Promise<string | null> {
    const { error, tempPassword } = await resetPassword(u.id);
    if (error) { toast.error(error); return null; }
    void logAudit({ usuarioId: u.id, accion: 'reset_password' });
    return tempPassword ?? null;
  }

  if (editando) {
    return (
      <FichaUsuario
        usuario={editando === 'nuevo' ? null : editando}
        locales={locales}
        marcas={marcas}
        roles={roles}
        onReset={editando !== 'nuevo' ? () => reset(editando) : undefined}
        onClose={() => setEditando(null)}
        onSaved={() => { setEditando(null); void reload(); }}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre o email…"
                 className="w-full rounded-lg border border-ink/15 bg-white pl-9 pr-3 py-2 text-sm" />
        </div>
        <div className="inline-flex rounded-lg border border-ink/15 bg-white p-0.5">
          <button onClick={() => setModo('lista')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium ${modo === 'lista' ? 'bg-brand-500 text-white' : 'text-ink-soft hover:bg-ink/5'}`}>Lista</button>
          <button onClick={() => setModo('matriz')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium ${modo === 'matriz' ? 'bg-brand-500 text-white' : 'text-ink-soft hover:bg-ink/5'}`}>Matriz de apps</button>
        </div>
        <button onClick={() => setEditando('nuevo')}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Nueva persona
        </button>
      </div>

      {modo === 'matriz' ? (
        <Accesos />
      ) : cargando ? (
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
                         onToggleActivo={() => void toggleActivo(u)} onReset={() => void reset(u).then((p) => p && window.prompt('Contraseña temporal (la cambia al entrar):', p))} />
          ))}
        </div>
      )}
    </div>
  );
}

function UsuarioCard({ u, locales, onEditar, onToggleActivo, onReset }: {
  u: Usuario; locales: LocalSimple[]; onEditar: () => void; onToggleActivo: () => void; onReset: () => void;
}) {
  const apps = u.apps_permitidas ?? ['pase'];
  const locsAsignados = (u.locales ?? []).map((id) => locales.find((l) => l.id === id)?.nombre).filter(Boolean);

  return (
    <div className={`rounded-xl bg-white border shadow-card px-4 py-3 ${u.activo ? 'border-ink/5' : 'border-ink/5 opacity-60'}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
          {(nombre(u)[0] ?? '?').toUpperCase()}
        </div>
        <div className="flex-1 min-w-[160px]">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium">{nombre(u)}</span>
            <span className="text-[10px] normal-case tracking-wide px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">{u.rol}</span>
            {apps.map((k) => {
              const app = APPS.find((a) => a.key === (k as AppKey));
              const op = app?.tier === 'operativa';
              return (
                <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${op ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-brand-100 text-brand-800 border-brand-200'}`}>
                  {app?.nombre ?? k}
                </span>
              );
            })}
            {u.password_temporal && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Password temporal</span>}
            {!u.activo && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">Inactivo</span>}
          </div>
          <div className="text-xs text-ink-muted mt-1 flex items-center gap-1.5 flex-wrap">
            <span>{u.email}</span>
            {locsAsignados.length > 0 && (
              <span className="inline-flex items-center gap-1 min-w-0"><span className="opacity-40">·</span><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">{locsAsignados.join(' · ')}</span></span>
            )}
          </div>
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

// ─── Ficha con acordeón ──────────────────────────────────────────────────────
function FichaUsuario({ usuario, locales, marcas, roles, onReset, onClose, onSaved }: {
  usuario: Usuario | null;
  locales: LocalSimple[];
  marcas: MarcaConLocales[];
  roles: Rol[];
  onReset?: () => Promise<string | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const esEdicion = usuario !== null;
  const [nombreT, setNombre] = useState(usuario?.nombre ?? '');
  const [email, setEmail] = useState(usuario?.email ?? '');
  const [rolId, setRolId] = useState<string | null>(usuario?.rol_id ?? null);
  const [password, setPassword] = useState('');
  const [tempPass, setTempPass] = useState<string | null>(null);
  const [apps, setApps] = useState<string[]>(usuario?.apps_permitidas ?? ['pase']);
  const [locsPase, setLocsPase] = useState<number[]>(usuario?.locales ?? []);
  const [permisos, setPermisosState] = useState<string[]>(usuario?.permisos ?? []);
  const [accesosApp, setAccesosApp] = useState<Record<string, { locales?: number[]; permisos?: string[] }>>(usuario?.accesos_por_app ?? {});
  const [abierto, setAbierto] = useState<Set<string>>(new Set()); // todo cerrado por defecto
  const [guardando, setGuardando] = useState(false);

  const selectedRole = roles.find((r) => r.id === rolId) ?? null;
  const rolePerms = new Set(selectedRole?.permisos ?? []);

  function toggleOpen(k: string) { setAbierto((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }
  function toggleApp(k: string) { setApps((a) => a.includes(k) ? a.filter((x) => x !== k) : [...a, k]); }
  function togglePerm(slug: string) { setPermisosState((p) => p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]); }

  // Locales por app: PASE usa el modelo real (locsPase); el resto, accesosApp[app].
  function localesDeApp(key: string): number[] {
    return key === 'pase' ? locsPase : (accesosApp[key]?.locales ?? []);
  }
  function setLocalesDeApp(key: string, next: number[]) {
    if (key === 'pase') { setLocsPase(next); return; }
    setAccesosApp((a) => ({ ...a, [key]: { ...a[key], locales: next } }));
  }
  function toggleLocalApp(key: string, id: number) {
    const cur = localesDeApp(key);
    setLocalesDeApp(key, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }
  function toggleMarcaApp(key: string, ids: number[]) {
    const cur = localesDeApp(key);
    const todos = ids.every((id) => cur.includes(id));
    setLocalesDeApp(key, todos ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])]);
  }

  // Permisos por app: PASE usa el modelo real (permisos, con "viene del rol");
  // el resto (COMANDA) se guarda en accesosApp[app].permisos, on/off simple.
  function permisosDeApp(key: string): string[] {
    return key === 'pase' ? permisos : (accesosApp[key]?.permisos ?? []);
  }
  function togglePermApp(key: string, slug: string) {
    if (key === 'pase') { togglePerm(slug); return; }
    const cur = permisosDeApp(key);
    const next = cur.includes(slug) ? cur.filter((x) => x !== slug) : [...cur, slug];
    setAccesosApp((a) => ({ ...a, [key]: { ...a[key], permisos: next } }));
  }

  async function resetear() {
    if (!onReset) return;
    const p = await onReset();
    if (p) { setTempPass(p); toast.success('Contraseña nueva generada'); }
  }

  async function guardar() {
    if (!nombreT.trim()) { toast.error('Falta el nombre'); return; }
    if (!email.trim()) { toast.error('Falta el email'); return; }
    if (!esEdicion && (!password || password.length < 6)) { toast.error('La contraseña inicial debe tener al menos 6 caracteres'); return; }
    const rolSlug = selectedRole?.slug === 'dueno'
      ? 'dueno'
      : (selectedRole ? 'encargado' : (usuario?.rol ?? 'encargado'));
    setGuardando(true);
    try {
      if (esEdicion && usuario) {
        const sync = await sincronizarUsuario({
          usuarioId: usuario.id, rol: rolSlug, rolId, modulos: permisos, locales: locsPase,
          cuentasVisibles: usuario.cuentas_visibles ?? null, cuentasOperables: usuario.cuentas_operables ?? null,
          cuentasAll: usuario.cuentas_visibles == null,
        });
        if (sync.error) { toast.error(sync.error); return; }
        const upd = await actualizarUsuario(usuario.id, { apps_permitidas: apps, accesos_por_app: accesosApp });
        if (upd.error) { toast.error('Permisos guardados pero falló apps: ' + upd.error); return; }
        void logAudit({ usuarioId: usuario.id, accion: 'editar', detalle: { rolId } });
      } else {
        const { id, error } = await crearUsuario({ email: email.trim(), nombre: nombreT.trim(), rol: rolSlug, password, apps_permitidas: apps, rol_id: rolId });
        if (error || !id) { toast.error(error ?? 'No se pudo crear'); return; }
        const sync = await sincronizarUsuario({
          usuarioId: id, rol: rolSlug, rolId, modulos: permisos, locales: locsPase,
          cuentasVisibles: null, cuentasOperables: null, cuentasAll: true,
        });
        if (sync.error) { toast.error('Usuario creado pero falló permisos: ' + sync.error); return; }
        if (Object.keys(accesosApp).length) await actualizarUsuario(id, { accesos_por_app: accesosApp });
        void logAudit({ usuarioId: id, accion: 'crear' });
      }
      toast.success(esEdicion ? 'Usuario actualizado' : 'Usuario creado');
      onSaved();
    } finally { setGuardando(false); }
  }

  const inicial = (nombreT || email || '?')[0]?.toUpperCase() ?? '?';

  return (
    <div className="space-y-3 max-w-3xl">
      <button onClick={onClose} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-brand-700">
        <ArrowLeft className="h-4 w-4" /> Personas
      </button>

      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 flex items-center gap-4 flex-wrap">
        <div className="w-14 h-14 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-xl shrink-0">{inicial}</div>
        <div className="flex-1 min-w-[160px]">
          <h2 className="text-xl font-medium">{esEdicion ? (usuario?.nombre || usuario?.email) : 'Nueva persona'}</h2>
          {esEdicion && <div className="text-sm text-ink-muted mt-0.5">{usuario?.email}</div>}
        </div>
      </div>

      {/* Credenciales — email + contraseña. Siempre visible. */}
      <section className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-3">
        <p className="text-sm font-medium">Credenciales <span className="text-xs font-normal text-ink-muted">· un solo usuario y contraseña para todas las apps</span></p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Usuario (email)</label>
            {esEdicion ? (
              <div className="flex gap-2">
                <input value={email} disabled className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm bg-ink/5" />
                <button type="button" onClick={() => { void navigator.clipboard.writeText(email); toast.success('Email copiado'); }}
                        className="px-2.5 rounded-lg border border-ink/15 hover:bg-ink/5" title="Copiar"><Copy className="h-4 w-4" /></button>
              </div>
            ) : (
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="persona@ejemplo.com"
                     className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Contraseña</label>
            {!esEdicion ? (
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="text" placeholder="Contraseña inicial (mín. 6)"
                     className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            ) : tempPass ? (
              <div className="flex gap-2">
                <input value={tempPass} readOnly className="flex-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-mono" />
                <button type="button" onClick={() => { void navigator.clipboard.writeText(tempPass); toast.success('Contraseña copiada'); }}
                        className="px-2.5 rounded-lg border border-ink/15 hover:bg-ink/5" title="Copiar"><Copy className="h-4 w-4" /></button>
              </div>
            ) : (
              <button type="button" onClick={() => void resetear()}
                      className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-ink/5 inline-flex items-center justify-center gap-1.5">
                <KeyRound className="h-4 w-4" /> Generar contraseña nueva
              </button>
            )}
          </div>
        </div>
        {esEdicion && (
          <p className="text-[11px] text-ink-muted">Por seguridad la contraseña actual no se puede ver (está encriptada). Si no la sabés, generá una nueva y pasásela — la persona la cambia al entrar.</p>
        )}
      </section>

      {/* Datos básicos */}
      <Seccion titulo="Datos básicos" icon={<UserIcon className="h-4 w-4" />} abierto={abierto.has('datos')} onToggle={() => toggleOpen('datos')}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Nombre *</label>
            <input value={nombreT} onChange={(e) => setNombre(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Rol</label>
            <select value={rolId ?? ''} onChange={(e) => setRolId(e.target.value || null)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              <option value="">— Sin rol —</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select>
            {selectedRole && <p className="text-[11px] text-ink-muted">Trae {rolePerms.size} permiso{rolePerms.size === 1 ? '' : 's'} de PASE. Ajustá en cada app.</p>}
          </div>
        </div>
      </Seccion>

      {/* Una barra por app */}
      <p className="text-xs text-ink-muted px-1 pt-1">Accesos por app — tocá una para asignar sus locales y permisos</p>
      {APPS.map((a) => {
        const on = apps.includes(a.key);
        const usaLoc = APPS_CON_LOCALES.has(a.key);
        const catPerms = catalogoPermisosApp(a.key);
        const esPase = a.key === 'pase';
        const permApp = permisosDeApp(a.key);
        const nLoc = localesDeApp(a.key).length;
        const op = a.tier === 'operativa';
        return (
          <Seccion key={a.key}
            titulo={a.nombre}
            icon={<span className={`w-2 h-2 rounded-full ${op ? 'bg-amber-500' : 'bg-brand-500'}`} />}
            abierto={abierto.has(a.key)} onToggle={() => toggleOpen(a.key)}
            right={
              <span onClick={(e) => { e.stopPropagation(); toggleApp(a.key); }}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-medium cursor-pointer ${on ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink/15 text-ink-soft'}`}>
                {on ? 'Con acceso' : 'Sin acceso'}
              </span>
            }
            sub={on ? (usaLoc ? `${nLoc === 0 ? 'Todos los' : nLoc} local${nLoc === 1 ? '' : 'es'}` : (op ? 'Entra sin PIN' : 'Acceso completo')) : undefined}
          >
            {!on ? (
              <div className="text-sm text-ink-muted">Sin acceso a {a.nombre}. Tocá "Sin acceso" arriba para dárselo.</div>
            ) : (
              <div className="space-y-4">
                {usaLoc && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-ink-soft">Locales <span className="font-normal text-ink-muted">(vacío = todos)</span></p>
                    <LocalesPicker marcas={marcas} locales={locales} value={localesDeApp(a.key)}
                                   onToggle={(id) => toggleLocalApp(a.key, id)} onToggleMarca={(ids) => toggleMarcaApp(a.key, ids)} />
                  </div>
                )}
                {catPerms ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-ink-soft">Permisos {esPase && <span className="font-normal text-ink-muted">· arrancan del rol, tocá para ajustar</span>}</p>
                    {esPase && (
                      <div className="flex flex-wrap gap-4 text-[11px] text-ink-soft bg-brand-50 rounded-lg px-3 py-2">
                        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-ink/10 border border-ink/15" />Viene del rol</span>
                        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-brand-500" />Ajuste</span>
                        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-white border border-ink/20" />Sin acceso</span>
                      </div>
                    )}
                    {catPerms.map((cat) => (
                      <div key={cat.titulo} className="rounded-xl border border-ink/10 p-3">
                        <p className="text-sm font-medium mb-2">{cat.titulo}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {cat.permisos.map((p) => {
                            const inUser = permApp.includes(p.slug);
                            const inRole = esPase && rolePerms.has(p.slug);
                            const cls = inUser ? 'bg-brand-500 text-white border-brand-500' : inRole ? 'bg-ink/5 text-ink-soft border-transparent' : 'bg-white text-ink-soft border-ink/15';
                            return <button key={p.slug} type="button" onClick={() => togglePermApp(a.key, p.slug)} title={p.descripcion} className={`text-xs px-2.5 py-1 rounded-full border ${cls}`}>{p.label}</button>;
                          })}
                        </div>
                      </div>
                    ))}
                    {!esPase && <p className="text-[10px] text-ink-muted">Se aplican cuando la persona entra a {a.nombre} con su cuenta (enganche por email — próxima fase).</p>}
                  </div>
                ) : usaLoc ? (
                  <p className="text-[11px] text-ink-muted inline-flex items-center gap-1.5"><Lock className="h-3 w-3" /> {a.nombre} todavía no tiene permisos por rol. Por ahora: acceso + locales.</p>
                ) : (
                  <p className="text-[11px] text-ink-muted">{op ? 'Entra sin PIN con su rol.' : 'Acceso a nivel cuenta (sin locales ni permisos por ahora).'}</p>
                )}
              </div>
            )}
          </Seccion>
        );
      })}

      <div className="flex gap-2 pt-1 pb-2">
        <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
        <button onClick={() => void guardar()} disabled={guardando}
                className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
          {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear persona'}
        </button>
      </div>
    </div>
  );
}

// Sección colapsable. Cerrada salvo que `abierto`.
function Seccion({ titulo, sub, icon, right, abierto, onToggle, children }: {
  titulo: string; sub?: string; icon?: React.ReactNode; right?: React.ReactNode;
  abierto: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-ink/[0.02]">
        <div className="flex items-center gap-2.5 min-w-0">
          {icon}
          <div className="min-w-0">
            <div className="font-medium text-sm">{titulo}</div>
            {sub && <div className="text-xs text-ink-muted mt-0.5 truncate">{sub}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {right}
          <ChevronDown className={`h-4 w-4 text-ink-muted transition-transform ${abierto ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {abierto && <div className="px-5 pb-5 pt-1 border-t border-ink/5">{children}</div>}
    </section>
  );
}

// Selector de locales con atajo por marca.
function LocalesPicker({ marcas, locales, value, onToggle, onToggleMarca }: {
  marcas: MarcaConLocales[]; locales: LocalSimple[]; value: number[];
  onToggle: (id: number) => void; onToggleMarca: (ids: number[]) => void;
}) {
  return (
    <div className="space-y-2">
      {marcas.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] text-ink-muted self-center">Por marca:</span>
          {marcas.map((m) => {
            const todos = m.localIds.every((id) => value.includes(id));
            return (
              <button key={m.id} type="button" onClick={() => onToggleMarca(m.localIds)}
                      className={`text-xs px-3 py-1.5 rounded-full border font-medium ${todos ? 'bg-brand-100 text-brand-800 border-brand-300' : 'bg-white border-ink/15 text-ink-soft hover:bg-ink/5'}`}>
                {m.nombre}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {locales.map((l) => (
          <button key={l.id} type="button" onClick={() => onToggle(l.id)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${value.includes(l.id) ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink/15 text-ink-soft'}`}>
            {value.includes(l.id) && <Check className="h-3 w-3 inline mr-1" />}{l.nombre}
          </button>
        ))}
      </div>
    </div>
  );
}
