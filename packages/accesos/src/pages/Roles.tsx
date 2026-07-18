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
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">03 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">Roles</h1>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap border-b border-carbon-600">
        <div className="inline-flex gap-6">
          <button onClick={() => setFamilia('gestion')}
                  className={`pb-2.5 -mb-px font-mono text-xs uppercase tracking-widest2 border-b-2 transition-colors ${familia === 'gestion' ? 'border-brand-400 text-brand-300' : 'border-transparent text-dim-300 hover:text-dim-100'}`}>Gestión · MAIL</button>
          <button onClick={() => setFamilia('pos')}
                  className={`pb-2.5 -mb-px font-mono text-xs uppercase tracking-widest2 border-b-2 transition-colors ${familia === 'pos' ? 'border-brand-400 text-brand-300' : 'border-transparent text-dim-300 hover:text-dim-100'}`}>POS · PIN</button>
        </div>
        {familia === 'gestion' && (
          <button onClick={() => setCreando(true)}
                  className="mb-2 rounded-sm bg-transparent border-0 hover:border-brand-400 hover:bg-brand-400/10 text-brand-300 font-mono uppercase tracking-widest2 px-3 h-8 text-xs inline-flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Nuevo rol
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
        <div className="grid md:grid-cols-[360px_1fr] border-t border-carbon-600 min-h-[500px]">
          {/* Lista de roles — filas apiladas con hairlines, sin cards individuales. */}
          <aside className="md:border-r md:border-carbon-600 md:pr-5">
            {roles.map((r) => {
              const activo = sel?.id === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setSel(r)}
                  className={`relative w-full text-left border-b border-carbon-600 py-3.5 px-1 flex items-center gap-3 transition-colors ${activo ? 'bg-brand-400/[0.06]' : 'hover:bg-brand-400/[0.03]'}`}
                >
                  {activo && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-brand-400" />}
                  <Lock className={`h-4 w-4 shrink-0 ${activo ? 'text-brand-400' : 'text-dim-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-dim-50 truncate">{r.nombre}</span>
                      <span className={`font-mono text-[10px] uppercase tracking-widest2 shrink-0 ${activo ? 'text-brand-300' : 'text-dim-400'}`}>
                        {r.permisos.length} PERMS
                      </span>
                    </div>
                    {r.descripcion && <p className="text-xs text-dim-300 mt-1 line-clamp-2">{r.descripcion}</p>}
                  </div>
                </button>
              );
            })}
          </aside>

          {/* Editor / detalle */}
          {sel ? (
            <div className="md:pl-8 pt-5 space-y-5">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <ShieldCheck className="h-5 w-5 text-brand-400" />
                    <span className="text-xl font-semibold text-dim-50">{sel.nombre}</span>
                    <span className="font-mono text-[10px] uppercase tracking-widest2 text-dim-400">
                      {sel.permisos.length} PERMS · GESTIÓN
                    </span>
                  </div>
                  {sel.descripcion && <p className="text-sm text-dim-300 mt-2">{sel.descripcion}</p>}
                </div>
                {!sel.sistema && (
                  <button
                    onClick={() => void borrar(sel)}
                    className="h-8 px-2.5 rounded-sm border-0 hover:border-crit hover:bg-crit/10 text-crit font-mono uppercase tracking-widest2 text-[11px] inline-flex items-center gap-1.5"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Borrar
                  </button>
                )}
              </div>

              <AppPerms label="PASE" categorias={CATEGORIAS} activos={sel.permisos} toggle={toggle} />
              <AppPerms label="COMANDA" categorias={CATEGORIAS_COMANDA} activos={sel.permisos} toggle={toggle} />
              <p className="text-[11px] text-dim-400 pt-2">
                Al elegir este rol en una persona se autocompletan estos permisos (PASE y COMANDA); después se ajustan en su ficha.
              </p>
            </div>
          ) : (
            <div className="md:pl-8 py-16 flex items-start justify-center">
              <div className="border border-dashed border-carbon-500 px-10 py-8 text-center max-w-sm">
                <p className="font-mono text-[11px] uppercase tracking-widest2 text-dim-300">
                  Elegí un rol a la izquierda
                </p>
                <p className="font-mono text-[10px] tracking-widest2 text-brand-400 mt-1.5">
                  ← // SELECT_ROLE
                </p>
              </div>
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
// Look Command Center: chips outline mono uppercase, categorías con label mono
// + count, sin cajas envolventes.
function AppPerms({ label, categorias, activos, toggle }: {
  label: string; categorias: CategoriaPermisos[]; activos: string[]; toggle: (slug: string) => void;
}) {
  const set = new Set(activos);
  const n = categorias.reduce((a, c) => a + c.permisos.filter((p) => set.has(p.slug)).length, 0);
  const total = categorias.reduce((a, c) => a + c.permisos.length, 0);
  return (
    <div className="border-t border-carbon-600 pt-4">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-mono text-xs uppercase tracking-widest2 text-dim-100 font-medium">{label}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-dim-400">
          {n} / {total} ACTIVOS
        </span>
      </div>
      <div className="space-y-4">
        {categorias.map((cat) => {
          const activosCat = cat.permisos.filter((p) => set.has(p.slug)).length;
          return (
            <div key={cat.titulo}>
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="font-mono text-[11px] uppercase tracking-widest2 text-dim-200">{cat.titulo}</span>
                <span className="font-mono text-[10px] tracking-widest2 text-dim-400">{activosCat} / {cat.permisos.length}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {cat.permisos.map((p) => {
                  const on = set.has(p.slug);
                  return (
                    <button
                      key={p.slug}
                      onClick={() => void toggle(p.slug)}
                      title={p.descripcion}
                      className={`font-mono text-[11px] uppercase tracking-widest2 transition-colors inline-flex items-center gap-1.5 ${
                        on
                          ? 'text-brand-300 hover:text-brand-200'
                          : 'text-dim-400 hover:text-dim-200'
                      }`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 rounded-full transition-colors ${on ? 'bg-brand-400' : 'bg-carbon-500'}`} />
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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
    <div className="grid md:grid-cols-[360px_1fr] border-t border-carbon-600 min-h-[500px]">
      {/* Lista de roles POS — filas con hairlines. */}
      <aside className="md:border-r md:border-carbon-600 md:pr-5">
        {ROLES_POS.map((r) => {
          const activo = sel === r;
          const n = (perms[r] ?? []).includes('*') ? '∞' : (perms[r] ?? []).length;
          return (
            <button
              key={r}
              onClick={() => setSel(r)}
              className={`relative w-full text-left border-b border-carbon-600 py-3.5 px-1 flex items-center gap-3 transition-colors ${activo ? 'bg-brand-400/[0.06]' : 'hover:bg-brand-400/[0.03]'}`}
            >
              {activo && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-brand-400" />}
              <Lock className={`h-4 w-4 shrink-0 ${activo ? 'text-brand-400' : 'text-dim-400'}`} />
              <div className="flex-1 flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-dim-50">{ROL_POS_LABEL[r]}</span>
                <span className={`font-mono text-[10px] uppercase tracking-widest2 ${activo ? 'text-brand-300' : 'text-dim-400'}`}>
                  {n} {typeof n === 'number' && n === 1 ? 'PERM' : 'PERMS'}
                </span>
              </div>
            </button>
          );
        })}
      </aside>

      <div className="md:pl-8 pt-5 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <ShieldCheck className="h-5 w-5 text-brand-400" />
          <span className="text-xl font-semibold text-dim-50">{ROL_POS_LABEL[sel]}</span>
          <span className="font-mono text-[10px] uppercase tracking-widest2 text-dim-400">
            ROL DEL PIN EN EL POS
          </span>
        </div>
        {esTotal ? (
          <p className="text-sm text-dim-300 inline-flex items-center gap-2">
            <Lock className="h-4 w-4" /> Acceso total al POS (no editable).
          </p>
        ) : (
          <>
            <AppPerms label="Permisos del POS" categorias={CATEGORIAS_ROL_POS} activos={slugs} toggle={toggle} />
            <div className="flex items-center gap-3 pt-1 flex-wrap">
              <button
                onClick={async () => {
                  const nuevos = slugs.length >= TODOS_SLUGS_ROL_POS.length ? [] : [...TODOS_SLUGS_ROL_POS];
                  setPerms((p) => ({ ...p, [sel]: nuevos }));
                  const { error } = await setRolPosPermisos(sel, nuevos);
                  if (error) { toast.error(error); void reload(); }
                }}
                className="h-7 px-2.5 rounded-sm border-b border-carbon-600 hover:border-brand-400 hover:bg-brand-400/10 text-brand-300 font-mono uppercase tracking-widest2 text-[10px]"
              >
                {slugs.length >= TODOS_SLUGS_ROL_POS.length ? 'Sacar todos' : 'Dar todos'}
              </button>
              <p className="text-[11px] text-dim-400">Este rol aplica a los empleados que entran con PIN en el POS.</p>
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
    <div className="fixed inset-0 z-50 bg-carbon-900/80 backdrop-blur flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm bg-carbon-800 border-b border-carbon-600 rounded-t-sm sm:rounded-sm shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-brand-400 tracking-widest2">NEW //</span>
            <h3 className="text-lg font-semibold text-dim-50">Nuevo rol</h3>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-sm hover:bg-carbon-700 text-dim-300 inline-flex items-center justify-center"><X className="h-4 w-4" /></button>
        </div>
        <div>
          <p className="label-sys mb-1.5">Nombre *</p>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full h-9 rounded-sm border-b border-carbon-600 bg-transparent px-3 text-sm font-mono text-dim-50 placeholder:text-dim-400 focus:outline-none focus:border-brand-400"
                 placeholder="Encargado de turno" />
        </div>
        <div>
          <p className="label-sys mb-1.5">Descripción</p>
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
                 className="w-full h-9 rounded-sm border-b border-carbon-600 bg-transparent px-3 text-sm font-mono text-dim-50 placeholder:text-dim-400 focus:outline-none focus:border-brand-400"
                 placeholder="Para qué sirve este rol" />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-sm border-b border-carbon-600 bg-transparent text-dim-200 font-mono uppercase tracking-widest2 text-xs hover:bg-carbon-700"
          >
            Cancelar
          </button>
          <button
            onClick={() => void submit()} disabled={guardando}
            className="flex-1 h-9 rounded-sm border-0 hover:border-brand-400 hover:bg-brand-400/10 text-brand-300 font-mono uppercase tracking-widest2 text-xs disabled:opacity-40"
          >
            {guardando ? 'Creando…' : 'Crear rol'}
          </button>
        </div>
      </div>
    </div>
  );
}
