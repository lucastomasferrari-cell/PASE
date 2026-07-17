// Roles y permisos — RBAC. Editás los permisos de cada rol y los cambios se
// propagan a TODOS los usuarios con ese rol al instante (mejor que tildar
// permisos uno por uno por usuario). Porteado de RolesPermisos.tsx de PASE.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, ShieldCheck, Trash2, X, Lock } from 'lucide-react';
import { listRoles, crearRol, setPermisosRol, eliminarRol, type Rol } from '@/lib/rolesService';
import { CATEGORIAS, type CategoriaPermisos } from '@/lib/permisos';
import { CATEGORIAS_COMANDA } from '@/lib/permisosComanda';
import { listRolPosPermisos, setRolPosPermisos } from '@/lib/rolPosService';
import { CATEGORIAS_ROL_POS, TODOS_SLUGS_ROL_POS, ROLES_POS, ROL_POS_LABEL, type RolPos } from '@/lib/permisosRolPos';

export function Roles() {
  const [roles, setRoles] = useState<Rol[]>([]);
  const [sel, setSel] = useState<Rol | null>(null);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);
  const [familia, setFamilia] = useState<'gestion' | 'pos'>('gestion');

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listRoles();
    if (error) toast.error(error);
    setRoles(data);
    // mantener el rol seleccionado tras un reload
    if (sel) {
      const upd = data.find((r) => r.id === sel.id);
      if (upd) setSel(upd);
    }
    setCargando(false);
  }, [sel]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, []);

  async function toggle(slug: string) {
    if (!sel) return;
    const nuevos = sel.permisos.includes(slug) ? sel.permisos.filter((p) => p !== slug) : [...sel.permisos, slug];
    setSel({ ...sel, permisos: nuevos });
    const { error } = await setPermisosRol(sel.id, nuevos);
    if (error) { toast.error(error); void reload(); }
  }

  async function borrar(r: Rol) {
    if (r.sistema) { toast.error('No se pueden borrar roles del sistema'); return; }
    if (!window.confirm(`¿Borrar el rol "${r.nombre}"?`)) return;
    const { error } = await eliminarRol(r.id);
    if (error) { toast.error(error); return; }
    toast.success('Rol borrado');
    setSel(null);
    void reload();
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-carbon-500 bg-carbon-800 p-0.5">
          <button onClick={() => setFamilia('gestion')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium ${familia === 'gestion' ? 'bg-brand-400 text-white' : 'text-dim-200 hover:bg-carbon-700'}`}>Roles de gestión (mail)</button>
          <button onClick={() => setFamilia('pos')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium ${familia === 'pos' ? 'bg-brand-400 text-white' : 'text-dim-200 hover:bg-carbon-700'}`}>Roles del POS (PIN)</button>
        </div>
        {familia === 'gestion' && (
          <button onClick={() => setCreando(true)}
                  className="rounded-lg bg-brand-400 hover:bg-brand-500 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
            <Plus className="h-4 w-4" /> Nuevo rol
          </button>
        )}
      </div>

      <p className="text-xs text-dim-300">
        {familia === 'gestion'
          ? 'Roles de las personas que entran con mail + contraseña (PASE, COMANDA admin). Se aplican al instante a todos los usuarios con ese rol.'
          : 'Roles de los empleados que entran con PIN en el terminal del POS. Definen qué puede hacer cada uno en el POS.'}
      </p>

      {familia === 'pos' ? (
        <RolesPos />
      ) : cargando ? (
        <div className="py-16 text-center text-dim-300">Cargando…</div>
      ) : (
        <div className="grid md:grid-cols-[260px_1fr] gap-4">
          {/* Lista de roles */}
          <aside className="space-y-1">
            {roles.map((r) => (
              <button key={r.id} onClick={() => setSel(r)}
                      className={`w-full text-left rounded-xl border p-3 transition-colors ${sel?.id === r.id ? 'border-brand-400 bg-brand-400/10' : 'border-carbon-600 bg-carbon-800 hover:bg-carbon-700'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium inline-flex items-center gap-1.5">
                    {r.sistema && <Lock className="h-3.5 w-3.5 text-dim-300" />} {r.nombre}
                  </span>
                  <span className="text-xs text-dim-300">{r.permisos.length}</span>
                </div>
                {r.descripcion && <p className="text-[11px] text-dim-300 mt-0.5 line-clamp-2">{r.descripcion}</p>}
              </button>
            ))}
          </aside>

          {/* Editor */}
          {sel ? (
            <div className="rounded-2xl bg-carbon-800 border border-carbon-600 shadow-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-xl font-medium inline-flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-brand-400" />{sel.nombre}
                  </div>
                  {sel.descripcion && <p className="text-sm text-dim-300 mt-0.5">{sel.descripcion}</p>}
                </div>
                {!sel.sistema && (
                  <button onClick={() => void borrar(sel)} className="text-xs text-crit hover:text-crit inline-flex items-center gap-1">
                    <Trash2 className="h-3.5 w-3.5" /> Borrar rol
                  </button>
                )}
              </div>

              <AppPerms label="PASE" categorias={CATEGORIAS} activos={sel.permisos} toggle={toggle} />
              <div className="border-t border-carbon-600" />
              <AppPerms label="COMANDA" categorias={CATEGORIAS_COMANDA} activos={sel.permisos} toggle={toggle} />
              <p className="text-[11px] text-dim-300">Al elegir este rol en una persona se autocompletan estos permisos (PASE y COMANDA); después se ajustan en su ficha.</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-carbon-800 border border-carbon-600 shadow-card py-14 text-center text-sm text-dim-300">
              Elegí un rol a la izquierda para ver/editar sus permisos.
            </div>
          )}
        </div>
      )}

      {creando && (
        <FormRol onClose={() => setCreando(false)} onSaved={() => { setCreando(false); void reload(); }} />
      )}
    </div>
  );
}

// Permisos de una app para el rol (chips). `activos` = slugs que tiene el rol.
function AppPerms({ label, categorias, activos, toggle }: {
  label: string; categorias: CategoriaPermisos[]; activos: string[]; toggle: (slug: string) => void;
}) {
  const set = new Set(activos);
  const n = categorias.reduce((a, c) => a + c.permisos.filter((p) => set.has(p.slug)).length, 0);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-dim-50">
        {label} <span className="text-[11px] font-normal text-dim-300">· {n} permiso{n === 1 ? '' : 's'}</span>
      </p>
      {categorias.map((cat) => (
        <div key={cat.titulo} className="space-y-1.5 pl-1">
          <p className="text-xs text-dim-300">{cat.titulo}</p>
          <div className="flex flex-wrap gap-1.5">
            {cat.permisos.map((p) => (
              <button key={p.slug} onClick={() => void toggle(p.slug)} title={p.descripcion}
                      className={`text-xs px-2.5 py-1 rounded-full border ${set.has(p.slug) ? 'bg-brand-100 text-brand-800 border-brand-400/50' : 'bg-carbon-800 text-dim-200 border-carbon-500'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Roles del POS (PIN): 5 roles fijos, permisos en rol_pos_permisos (global).
function RolesPos() {
  const [perms, setPerms] = useState<Record<RolPos, string[]>>({} as Record<RolPos, string[]>);
  const [sel, setSel] = useState<RolPos>('cajero');
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listRolPosPermisos();
    if (error) toast.error(error); else setPerms(data);
    setCargando(false);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const slugs = perms[sel] ?? [];
  const esTotal = slugs.includes('*');

  async function toggle(slug: string) {
    if (esTotal) return;
    const nuevos = slugs.includes(slug) ? slugs.filter((s) => s !== slug) : [...slugs, slug];
    setPerms((p) => ({ ...p, [sel]: nuevos }));
    const { error } = await setRolPosPermisos(sel, nuevos);
    if (error) { toast.error(error); void reload(); }
  }

  if (cargando) return <div className="py-16 text-center text-dim-300">Cargando…</div>;

  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-4">
      <aside className="space-y-1">
        {ROLES_POS.map((r) => {
          const n = (perms[r] ?? []).includes('*') ? '∞' : (perms[r] ?? []).length;
          return (
            <button key={r} onClick={() => setSel(r)}
                    className={`w-full text-left rounded-xl border p-3 transition-colors ${sel === r ? 'border-brand-400 bg-brand-400/10' : 'border-carbon-600 bg-carbon-800 hover:bg-carbon-700'}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{ROL_POS_LABEL[r]}</span>
                <span className="text-xs text-dim-300">{n}</span>
              </div>
            </button>
          );
        })}
      </aside>

      <div className="rounded-2xl bg-carbon-800 border border-carbon-600 shadow-card p-5 space-y-4">
        <div className="text-xl font-medium inline-flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-400" />{ROL_POS_LABEL[sel]}
          <span className="text-[11px] font-normal text-dim-300">· rol del PIN en el POS</span>
        </div>
        {esTotal ? (
          <p className="text-sm text-dim-300 inline-flex items-center gap-1.5">
            <Lock className="h-4 w-4" /> Acceso total al POS (no editable).
          </p>
        ) : (
          <>
            <AppPerms label="Permisos del POS" categorias={CATEGORIAS_ROL_POS} activos={slugs} toggle={toggle} />
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={async () => {
                  const nuevos = slugs.length >= TODOS_SLUGS_ROL_POS.length ? [] : [...TODOS_SLUGS_ROL_POS];
                  setPerms((p) => ({ ...p, [sel]: nuevos }));
                  const { error } = await setRolPosPermisos(sel, nuevos);
                  if (error) { toast.error(error); void reload(); }
                }}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-carbon-500 hover:bg-carbon-700 text-dim-200"
              >
                {slugs.length >= TODOS_SLUGS_ROL_POS.length ? 'Sacar todos' : 'Dar todos'}
              </button>
              <p className="text-[11px] text-dim-300">Este rol aplica a los empleados que entran con PIN en el POS.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FormRol({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!nombre.trim()) { toast.error('Falta el nombre'); return; }
    setGuardando(true);
    const { error } = await crearRol({ nombre: nombre.trim(), descripcion: descripcion.trim() || undefined });
    setGuardando(false);
    if (error) { toast.error(error); return; }
    toast.success('Rol creado');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm bg-carbon-800 rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium">Nuevo rol</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-carbon-700 text-dim-200"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim-200">Nombre *</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full rounded-lg border border-carbon-500 px-3 py-2 text-sm" placeholder="Encargado de turno" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim-200">Descripción</label>
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
                 className="w-full rounded-lg border border-carbon-500 px-3 py-2 text-sm" placeholder="Para qué sirve este rol" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-carbon-500 py-2.5 text-sm font-medium hover:bg-carbon-700">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-400 hover:bg-brand-500 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Creando…' : 'Crear rol'}
          </button>
        </div>
      </div>
    </div>
  );
}
