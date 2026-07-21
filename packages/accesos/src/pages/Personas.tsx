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
  Search, Plus, Power, KeyRound, MapPin, ArrowLeft, Lock,
  ChevronDown, Copy, RotateCcw, Wrench, User,
} from 'lucide-react';
import { SystemRow, SectionHeader, Chip } from '@/components/primitives';
import {
  listUsuarios, crearUsuario, actualizarUsuario, sincronizarUsuario,
  sincronizarComandaAcceso, resetPassword, listLocales, type Usuario,
} from '@/lib/usuariosService';
import { listRoles, type Rol } from '@/lib/rolesService';
import { logAudit } from '@/lib/auditService';
import { listMarcas, listLocalesConMarca } from '@/lib/marcasService';
import { APPS, type AppKey } from '@/lib/apps';
import { CATEGORIAS, type CategoriaPermisos } from '@/lib/permisos';
import { CATEGORIAS_COMANDA, normalizarPermisosComanda } from '@/lib/permisosComanda';

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
    <div>
      {/* Cabecera de sección + CTA. */}
      <SectionHeader
        label="Equipo activo"
        right={
          <button
            onClick={() => setEditando('nuevo')}
            className="mono text-[9px] font-semibold text-brand-400 hover:text-dim-50 flex items-center gap-2 border border-brand-400/20 px-3 py-1 rounded-[3px] transition-all uppercase tracking-widest"
          >
            <Plus className="h-3 w-3" /> Nueva persona
          </button>
        }
      />

      {/* Buscador — campo integrado slate. */}
      <div className="mb-8">
        <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/50 rounded border border-slate-800 focus-within:border-brand-400/40 transition-colors">
          <Search className="h-4 w-4 text-dim-300 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="BUSCAR POR NOMBRE O EMAIL…"
            className="flex-1 bg-transparent border-0 outline-none mono text-[10px] tracking-widest uppercase text-dim-50 placeholder:text-dim-400/70"
          />
        </div>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-dim-300 mono text-xs uppercase tracking-widest2">Cargando equipo…</div>
      ) : filtrados.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-medium text-dim-100">Sin resultados</p>
          <p className="text-sm text-dim-300 mt-1">Probá otra búsqueda o cargá una persona nueva.</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {filtrados.map((u) => (
            <UsuarioCard key={u.id} u={u} locales={locales} onEditar={() => setEditando(u)}
                         onToggleActivo={() => void toggleActivo(u)} onReset={() => void reset(u).then((p) => p && window.prompt('Contraseña temporal (la cambia al entrar):', p))} />
          ))}
        </div>
      )}
    </div>
  );
}

// Fila de persona — patrón cocina.os `SystemRow`. Toda la fila abre la ficha
// (editar); reset de contraseña y activar/desactivar son botones que aparecen
// al hover (con stopPropagation para no disparar el click de la fila).
function UsuarioCard({ u, locales, onEditar, onToggleActivo, onReset }: {
  u: Usuario; locales: LocalSimple[]; onEditar: () => void; onToggleActivo: () => void; onReset: () => void;
}) {
  const apps = u.apps_permitidas ?? ['pase'];
  const locsAsignados = (u.locales ?? []).map((id) => locales.find((l) => l.id === id)?.nombre).filter(Boolean);
  const appsLabel = apps
    .map((k) => (APPS.find((a) => a.key === (k as AppKey))?.nombre ?? k).toUpperCase())
    .join(' · ');

  return (
    <SystemRow
      icon={<User className="text-lg h-5 w-5" />}
      muted={!u.activo}
      onClick={onEditar}
      title={nombre(u)}
      suffix={appsLabel || undefined}
      description={
        locsAsignados.length > 0
          ? <span className="inline-flex items-center gap-1.5"><span>{u.email}</span><span className="opacity-40">·</span><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">{locsAsignados.join(' · ')}</span></span>
          : u.email
      }
      category={
        <>
          <Chip>{u.rol}</Chip>
          {u.password_temporal && <Chip tone="warn">TEMP PWD</Chip>}
        </>
      }
      status={u.activo ? { label: 'ACTIVE', tone: 'active' } : { label: 'LOCKED', tone: 'inactive' }}
      actions={
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onReset}
            className="h-7 w-7 rounded text-dim-300 hover:text-dim-50 hover:bg-carbon-700 inline-flex items-center justify-center transition-colors"
            title="Resetear contraseña"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleActivo}
            title={u.activo ? 'Desactivar' : 'Activar'}
            className={`h-7 w-7 rounded inline-flex items-center justify-center transition-colors ${
              u.activo ? 'text-warn/70 hover:text-warn hover:bg-warn/10' : 'text-live/70 hover:text-live hover:bg-live/10'
            }`}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    />
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
  // Permisos de PASE editables inline (Fase 1, 16-jul). Al elegir un rol se
  // autocompletan con los del rol; el dueño puede tildar/destildar acá mismo.
  // Se guardan por usuario en usuario_permisos (los respeta auth_tiene_permiso).
  const [permisos, setPermisos] = useState<string[]>(usuario?.permisos ?? []);
  const [accesosApp, setAccesosApp] = useState<Record<string, { locales?: number[]; permisos?: string[] }>>(usuario?.accesos_por_app ?? {});
  const [abierto, setAbierto] = useState<Set<string>>(new Set()); // todo cerrado por defecto
  const [guardando, setGuardando] = useState(false);

  const selectedRole = roles.find((r) => r.id === rolId) ?? null;
  // El rol puede traer permisos de PASE y de COMANDA (slugs comanda.*).
  const rolePerms = new Set((selectedRole?.permisos ?? []).filter((s) => !s.startsWith('comanda.')));
  const rolComandaCount = (selectedRole?.permisos ?? []).filter((s) => s.startsWith('comanda.')).length;

  function toggleOpen(k: string) { setAbierto((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }
  function toggleApp(k: string) { setApps((a) => a.includes(k) ? a.filter((x) => x !== k) : [...a, k]); }
  function togglePermiso(slug: string) { setPermisos((p) => p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]); }
  // Permisos de COMANDA viven en accesos_por_app.comanda.permisos.
  function togglePermisoComanda(slug: string) {
    setAccesosApp((a) => {
      const cur = a['comanda']?.permisos ?? [];
      const next = cur.includes(slug) ? cur.filter((x) => x !== slug) : [...cur, slug];
      return { ...a, comanda: { ...a['comanda'], permisos: next } };
    });
  }
  // Autocompletar con los permisos del rol (PASE + COMANDA), editables después.
  function elegirRol(id: string | null) {
    setRolId(id);
    const all = roles.find((x) => x.id === id)?.permisos ?? [];
    setPermisos(all.filter((s) => !s.startsWith('comanda.')));
    const comanda = all.filter((s) => s.startsWith('comanda.'));
    setAccesosApp((a) => ({ ...a, comanda: { ...a['comanda'], permisos: comanda } }));
  }
  // ¿Los permisos actuales difieren de los del rol? (para mostrar "personalizado").
  const permisosPersonalizados = selectedRole
    ? (permisos.length !== rolePerms.size || permisos.some((p) => !rolePerms.has(p)))
    : permisos.length > 0;

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
      const comandaOn = apps.includes('comanda');
      const cAcc = accesosApp['comanda'] ?? {};
      if (esEdicion && usuario) {
        const sync = await sincronizarUsuario({
          usuarioId: usuario.id, rol: rolSlug, rolId, modulos: permisos, locales: locsPase,
          cuentasVisibles: usuario.cuentas_visibles ?? null, cuentasOperables: usuario.cuentas_operables ?? null,
          cuentasAll: usuario.cuentas_visibles == null,
        });
        if (sync.error) { toast.error(sync.error); return; }
        const upd = await actualizarUsuario(usuario.id, { apps_permitidas: apps, accesos_por_app: accesosApp });
        if (upd.error) { toast.error('Permisos guardados pero falló apps: ' + upd.error); return; }
        // Enganche COMANDA: sincroniza el comanda_usuario (crea/actualiza o desactiva).
        const cs = await sincronizarComandaAcceso({
          usuarioId: usuario.id, activo: comandaOn, locales: cAcc.locales ?? null,
          permisos: normalizarPermisosComanda(cAcc.permisos ?? []),
        });
        if (cs.error) toast.error('Acceso a COMANDA no se sincronizó: ' + cs.error);
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
        if (comandaOn) {
          const cs = await sincronizarComandaAcceso({
            usuarioId: id, activo: true, locales: cAcc.locales ?? null,
            permisos: normalizarPermisosComanda(cAcc.permisos ?? []),
          });
          if (cs.error) toast.error('Usuario creado pero COMANDA no se sincronizó: ' + cs.error);
        }
        void logAudit({ usuarioId: id, accion: 'crear' });
      }
      toast.success(esEdicion ? 'Usuario actualizado' : 'Usuario creado');
      onSaved();
    } finally { setGuardando(false); }
  }

  const inicial = (nombreT || email || '?')[0]?.toUpperCase() ?? '?';

  return (
    <div className="space-y-3 max-w-3xl">
      <button onClick={onClose} className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-widest2 text-dim-300 hover:text-brand-400 transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Volver a personas
      </button>

      {/* Perfil — header + datos + credenciales, todo junto. */}
      <section className="border-t border-carbon-600">
        <div className="py-5 flex items-center gap-4 flex-wrap border-b border-carbon-600">
          <div className="w-14 h-14 rounded-sm bg-carbon-700 border-b border-carbon-600 text-brand-300 grid place-items-center font-mono text-xl shrink-0">{inicial}</div>
          <div className="flex-1 min-w-[160px]">
            <h2 className="text-xl font-medium text-dim-50">{esEdicion ? (usuario?.nombre || usuario?.email) : 'Nueva persona'}</h2>
            <div className="text-sm text-dim-300 mt-0.5">{esEdicion ? usuario?.email : 'Perfil de la persona'}</div>
          </div>
        </div>

        <div className="py-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-dim-200">Nombre *</label>
              <input value={nombreT} onChange={(e) => setNombre(e.target.value)} className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-dim-200">Rol</label>
              <select value={rolId ?? ''} onChange={(e) => elegirRol(e.target.value || null)} className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400">
                <option value="">— Sin rol —</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
              </select>
              {selectedRole && (
                <p className="text-[11px] text-dim-300">
                  Autocompleta {rolePerms.size} de PASE{rolComandaCount > 0 ? ` y ${rolComandaCount} de COMANDA` : ''}. Ajustalos abajo, en cada app.
                </p>
              )}
            </div>
          </div>

          <div className="pt-1 border-t border-carbon-600">
            <p className="text-[11px] font-medium text-dim-200 mt-3 mb-2 inline-flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> Credenciales <span className="font-normal text-dim-300">· un solo usuario y contraseña para todas las apps</span>
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-dim-200">Usuario (email)</label>
                {esEdicion ? (
                  <div className="flex gap-2">
                    <input value={email} disabled className="flex-1 bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
                    <button type="button" onClick={() => { void navigator.clipboard.writeText(email); toast.success('Email copiado'); }}
                            className="px-2 text-dim-300 hover:text-dim-50 transition-colors" title="Copiar"><Copy className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="persona@ejemplo.com"
                         className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-dim-200">Contraseña</label>
                {!esEdicion ? (
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type="text" placeholder="Contraseña inicial (mín. 6)"
                         className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
                ) : tempPass ? (
                  <div className="flex gap-2">
                    <input value={tempPass} readOnly className="flex-1 rounded-sm border border-emerald-300 bg-live/10 px-3 py-2 text-sm font-mono" />
                    <button type="button" onClick={() => { void navigator.clipboard.writeText(tempPass); toast.success('Contraseña copiada'); }}
                            className="px-2 text-dim-300 hover:text-dim-50 transition-colors" title="Copiar"><Copy className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <button type="button" onClick={() => void resetear()}
                          className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400 font-medium hover:bg-carbon-700 inline-flex items-center justify-center gap-1.5">
                    <KeyRound className="h-4 w-4" /> Generar contraseña nueva
                  </button>
                )}
              </div>
            </div>
            {esEdicion && (
              <p className="text-[11px] text-dim-300 mt-2">Por seguridad la contraseña actual no se puede ver (está encriptada). Si no la sabés, generá una nueva y pasásela — la persona la cambia al entrar.</p>
            )}
          </div>
        </div>
      </section>

      {/* Una barra por app */}
      <p className="text-xs text-dim-300 px-1 pt-1">Accesos por app — tocá una para darle acceso y elegir sus locales</p>
      {APPS.map((a) => {
        const on = apps.includes(a.key);
        const usaLoc = APPS_CON_LOCALES.has(a.key);
        const nLoc = localesDeApp(a.key).length;
        const op = a.tier === 'operativa';
        return (
          <Seccion key={a.key}
            titulo={a.nombre}
            icon={<span className={`w-2 h-2 rounded-full ${op ? 'bg-warn' : 'bg-brand-400'}`} />}
            abierto={abierto.has(a.key)} onToggle={() => toggleOpen(a.key)}
            right={
              <span onClick={(e) => { e.stopPropagation(); toggleApp(a.key); }}
                    className={`font-mono text-[11px] uppercase tracking-widest2 cursor-pointer transition-colors ${on ? 'text-brand-300 hover:text-brand-200' : 'text-dim-400 hover:text-dim-200'}`}>
                {on ? '● CON ACCESO' : '○ SIN ACCESO'}
              </span>
            }
            sub={on ? (
              a.key === 'pase'
                ? `${nLoc === 0 ? 'Todos los' : nLoc} local${nLoc === 1 ? '' : 'es'} · ${permisos.length} permiso${permisos.length === 1 ? '' : 's'}`
                : a.key === 'comanda'
                  ? `${nLoc === 0 ? 'Todos los' : nLoc} local${nLoc === 1 ? '' : 'es'} · ${(accesosApp['comanda']?.permisos ?? []).length} permiso${(accesosApp['comanda']?.permisos ?? []).length === 1 ? '' : 's'}`
                  : (usaLoc ? `${nLoc === 0 ? 'Todos los' : nLoc} local${nLoc === 1 ? '' : 'es'}` : (op ? 'Entra sin PIN' : 'Acceso completo'))
            ) : undefined}
          >
            {!on ? (
              <div className="text-sm text-dim-300">Sin acceso a {a.nombre}. Tocá "Sin acceso" arriba para dárselo.</div>
            ) : (
              <div className="space-y-4">
                {usaLoc && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-dim-200">Locales <span className="font-normal text-dim-300">(vacío = todos)</span></p>
                    <LocalesPicker marcas={marcas} locales={locales} value={localesDeApp(a.key)}
                                   onToggle={(id) => toggleLocalApp(a.key, id)} onToggleMarca={(ids) => toggleMarcaApp(a.key, ids)} />
                  </div>
                )}
                {a.key === 'pase' ? (
                  <PermisosPase
                    value={permisos}
                    onToggle={togglePermiso}
                    selectedRole={selectedRole}
                    personalizado={permisosPersonalizados}
                    onVolverAlRol={() => setPermisos(selectedRole ? [...selectedRole.permisos] : [])}
                  />
                ) : a.key === 'comanda' ? (
                  <PermisosComanda value={accesosApp['comanda']?.permisos ?? []} onToggle={togglePermisoComanda} />
                ) : (
                  <p className="text-[11px] text-dim-300 inline-flex items-center gap-1.5">
                    <Lock className="h-3 w-3" />
                    {op ? `Entra a ${a.nombre} sin PIN, con acceso completo.` : `Acceso completo a ${a.nombre}.`}
                    {' '}Lo que puede hacer lo define su <strong className="font-medium">rol{selectedRole ? ` (${selectedRole.nombre})` : ''}</strong>.
                  </p>
                )}
              </div>
            )}
          </Seccion>
        );
      })}

      <div className="flex gap-2 pt-1 pb-2">
        <button onClick={onClose}
                className="flex-1 rounded-[3px] border border-carbon-600 py-2.5 mono text-[11px] uppercase tracking-widest2 text-dim-300 hover:text-dim-50 hover:border-carbon-500 hover:bg-carbon-700 transition-colors">
          Cancelar
        </button>
        <button onClick={() => void guardar()} disabled={guardando}
                className="flex-1 rounded-[3px] border border-brand-400/30 bg-brand-400/10 py-2.5 mono text-[11px] uppercase tracking-widest2 text-brand-300 hover:bg-brand-400/20 hover:text-brand-200 hover:border-brand-400/60 transition-all disabled:opacity-50">
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
    <section className="border-b border-carbon-600">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-3 py-3.5 text-left hover:bg-brand-400/[0.03]">
        <div className="flex items-center gap-2.5 min-w-0">
          {icon}
          <div className="min-w-0">
            <div className="font-medium text-sm">{titulo}</div>
            {sub && <div className="text-xs text-dim-300 mt-0.5 truncate">{sub}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {right}
          <ChevronDown className={`h-4 w-4 text-dim-300 transition-transform ${abierto ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {abierto && <div className="px-5 pb-5 pt-1 border-t border-carbon-600">{children}</div>}
    </section>
  );
}

// Interruptor (switch) estilo pantalla de ajustes.
function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
            className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${on ? 'bg-brand-400' : 'bg-ink/20'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-carbon-800 shadow-sm transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

// Acordeón de permisos reutilizable (PASE y COMANDA). Secciones desplegables
// (como el sidebar); adentro cada permiso es una fila con descripción + switch.
function PermisosAccordion({ categorias, value, onToggle }: {
  categorias: CategoriaPermisos[];
  value: string[];
  onToggle: (slug: string) => void;
}) {
  const set = new Set(value);
  const activos = (cat: CategoriaPermisos) => cat.permisos.filter((p) => set.has(p.slug)).length;
  // Arrancan abiertas las secciones que ya tienen algún permiso activo.
  const [abiertas, setAbiertas] = useState<Set<string>>(
    () => new Set(categorias.filter((c) => c.permisos.some((p) => set.has(p.slug))).map((c) => c.titulo)),
  );
  function toggleSec(t: string) {
    setAbiertas((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  }
  return (
    <div className="rounded-sm border-b border-carbon-700 overflow-hidden">
      {categorias.map((cat, i) => {
        const open = abiertas.has(cat.titulo);
        const n = activos(cat);
        return (
          <div key={cat.titulo} className={i > 0 ? 'border-t border-carbon-600' : ''}>
            <button type="button" onClick={() => toggleSec(cat.titulo)}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-ink/[0.02]">
              <span className="text-sm font-medium text-dim-50 flex-1">{cat.titulo}</span>
              <span className={`text-[11px] tabular-nums ${n > 0 ? 'text-brand-400 font-medium' : 'text-dim-300'}`}>{n} de {cat.permisos.length}</span>
              <ChevronDown className={`h-4 w-4 text-dim-300 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
              <div className="border-t border-carbon-600 bg-ink/[0.04]">
                {cat.permisos.map((p, j) => {
                  const on = set.has(p.slug);
                  const wip = p.enDesarrollo === true;
                  return (
                    <div key={p.slug} className={`flex items-center gap-3 px-3.5 py-2.5 ${j > 0 ? 'border-t border-carbon-600' : ''} ${wip ? 'bg-amber-50/30' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm ${wip ? 'text-amber-900' : 'text-dim-50'}`}>{p.label}</span>
                          {wip && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800"
                              title="Función en desarrollo — activar el permiso no tiene efecto todavía"
                            >
                              <Wrench className="h-2.5 w-2.5" /> EN DESARROLLO
                            </span>
                          )}
                        </div>
                        {p.descripcion && <div className="text-[11px] text-dim-300 mt-0.5 leading-snug">{p.descripcion}</div>}
                      </div>
                      <Switch on={on} onClick={() => onToggle(p.slug)} label={p.label} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Permisos de PASE — autocompletados por el rol, ajustables acá.
function PermisosPase({ value, onToggle, selectedRole, personalizado, onVolverAlRol }: {
  value: string[];
  onToggle: (slug: string) => void;
  selectedRole: Rol | null;
  personalizado: boolean;
  onVolverAlRol: () => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-medium text-dim-200">
          Permisos en PASE <span className="font-normal text-dim-300">· {value.length} activo{value.length === 1 ? '' : 's'}</span>
        </p>
        {selectedRole && personalizado && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">Personalizado</span>
            <button type="button" onClick={onVolverAlRol}
                    className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-sm border-b border-carbon-600 hover:bg-carbon-700 text-dim-200">
              <RotateCcw className="h-3 w-3" /> Volver a los del rol
            </button>
          </div>
        )}
      </div>
      {!selectedRole && (
        <p className="text-[11px] text-dim-300">Elegí un rol arriba para autocompletar, o prendé los permisos a mano.</p>
      )}
      <PermisosAccordion categorias={CATEGORIAS} value={value} onToggle={onToggle} />
    </div>
  );
}

// Permisos de COMANDA — se guardan en accesos_por_app.comanda.permisos y se
// sincronizan al comanda_usuario al guardar (enganche por email).
function PermisosComanda({ value, onToggle }: {
  value: string[];
  onToggle: (slug: string) => void;
}) {
  return (
    <div className="space-y-2.5">
      <p className="text-xs font-medium text-dim-200">
        Permisos en COMANDA <span className="font-normal text-dim-300">· {value.length} activo{value.length === 1 ? '' : 's'}</span>
      </p>
      <PermisosAccordion categorias={CATEGORIAS_COMANDA} value={value} onToggle={onToggle} />
    </div>
  );
}

// Selector de locales — desplegable compacto. Cerrado muestra un resumen
// ("Todos los locales" / "3 de 5 locales"); se abre a una lista agrupada por
// marca (con interruptor "toda la marca") + interruptor por local.
function LocalesPicker({ marcas, locales, value, onToggle, onToggleMarca }: {
  marcas: MarcaConLocales[]; locales: LocalSimple[]; value: number[];
  onToggle: (id: number) => void; onToggleMarca: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = locales.length;
  const n = value.length;
  const resumen = n === 0 || n === total ? 'Todos los locales' : `${n} de ${total} locales`;
  const cubiertos = new Set(marcas.flatMap((m) => m.localIds));
  const sinMarca = locales.filter((l) => !cubiertos.has(l.id));
  const grupos = [
    ...marcas.map((m) => ({ nombre: m.nombre, ids: m.localIds })),
    ...(sinMarca.length ? [{ nombre: 'Sin marca', ids: sinMarca.map((l) => l.id) }] : []),
  ];
  return (
    <div className="rounded-sm border-b border-carbon-600 overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-ink/[0.02]">
        <MapPin className="h-4 w-4 text-dim-300 shrink-0" />
        <span className="text-sm text-dim-50 flex-1">{resumen}</span>
        <ChevronDown className={`h-4 w-4 text-dim-300 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-carbon-600 max-h-72 overflow-y-auto">
          {grupos.map((g, gi) => {
            const nMk = g.ids.filter((id) => value.includes(id)).length;
            const todos = nMk === g.ids.length;
            return (
              <div key={g.nombre} className={gi > 0 ? 'border-t border-carbon-600' : ''}>
                <div className="flex items-center gap-3 px-3 py-2 bg-ink/[0.03]">
                  <span className="text-[13px] font-medium text-dim-200 flex-1">{g.nombre}</span>
                  <span className="text-[11px] tabular-nums text-dim-300">{nMk}/{g.ids.length}</span>
                  <Switch on={todos} onClick={() => onToggleMarca(g.ids)} label={`Toda ${g.nombre}`} />
                </div>
                {g.ids.map((id) => {
                  const l = locales.find((x) => x.id === id);
                  if (!l) return null;
                  return (
                    <div key={id} className="flex items-center gap-3 px-3 py-2 pl-7 border-t border-carbon-600">
                      <span className="text-sm text-dim-50 flex-1">{l.nombre}</span>
                      <Switch on={value.includes(id)} onClick={() => onToggle(id)} label={l.nombre} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
