// Roles y permisos — RBAC. Editás los permisos de cada rol y los cambios se
// propagan a TODOS los usuarios con ese rol al instante (mejor que tildar
// permisos uno por uno por usuario). Porteado de RolesPermisos.tsx de PASE.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, ShieldCheck, Trash2, X, Lock } from 'lucide-react';
import { listRoles, crearRol, setPermisosRol, eliminarRol, type Rol } from '@/lib/rolesService';
import { CATEGORIAS, type CategoriaPermisos } from '@/lib/permisos';
import { CATEGORIAS_COMANDA } from '@/lib/permisosComanda';

export function Roles() {
  const [roles, setRoles] = useState<Rol[]>([]);
  const [sel, setSel] = useState<Rol | null>(null);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);

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
        <p className="text-sm text-ink-muted">Editá los permisos del rol y se aplica al instante a todos los usuarios con ese rol.</p>
        <button onClick={() => setCreando(true)}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Nuevo rol
        </button>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : (
        <div className="grid md:grid-cols-[260px_1fr] gap-4">
          {/* Lista de roles */}
          <aside className="space-y-1">
            {roles.map((r) => (
              <button key={r.id} onClick={() => setSel(r)}
                      className={`w-full text-left rounded-xl border p-3 transition-colors ${sel?.id === r.id ? 'border-brand-500 bg-brand-50' : 'border-ink/10 bg-white hover:bg-ink/5'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium inline-flex items-center gap-1.5">
                    {r.sistema && <Lock className="h-3.5 w-3.5 text-ink-muted" />} {r.nombre}
                  </span>
                  <span className="text-xs text-ink-muted">{r.permisos.length}</span>
                </div>
                {r.descripcion && <p className="text-[11px] text-ink-muted mt-0.5 line-clamp-2">{r.descripcion}</p>}
              </button>
            ))}
          </aside>

          {/* Editor */}
          {sel ? (
            <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-xl font-medium inline-flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-brand-500" />{sel.nombre}
                  </div>
                  {sel.descripcion && <p className="text-sm text-ink-muted mt-0.5">{sel.descripcion}</p>}
                </div>
                {!sel.sistema && (
                  <button onClick={() => void borrar(sel)} className="text-xs text-red-600 hover:text-red-700 inline-flex items-center gap-1">
                    <Trash2 className="h-3.5 w-3.5" /> Borrar rol
                  </button>
                )}
              </div>

              <AppPerms label="PASE" categorias={CATEGORIAS} sel={sel} toggle={toggle} />
              <div className="border-t border-ink/5" />
              <AppPerms label="COMANDA" categorias={CATEGORIAS_COMANDA} sel={sel} toggle={toggle} />
              <p className="text-[11px] text-ink-muted">Al elegir este rol en una persona se autocompletan estos permisos (PASE y COMANDA); después se ajustan en su ficha.</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center text-sm text-ink-muted">
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

// Permisos de una app (PASE o COMANDA) para el rol seleccionado.
function AppPerms({ label, categorias, sel, toggle }: {
  label: string; categorias: CategoriaPermisos[]; sel: Rol; toggle: (slug: string) => void;
}) {
  const n = categorias.reduce((a, c) => a + c.permisos.filter((p) => sel.permisos.includes(p.slug)).length, 0);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">
        {label} <span className="text-[11px] font-normal text-ink-muted">· {n} permiso{n === 1 ? '' : 's'}</span>
      </p>
      {categorias.map((cat) => (
        <div key={cat.titulo} className="space-y-1.5 pl-1">
          <p className="text-xs text-ink-muted">{cat.titulo}</p>
          <div className="flex flex-wrap gap-1.5">
            {cat.permisos.map((p) => (
              <button key={p.slug} onClick={() => void toggle(p.slug)} title={p.descripcion}
                      className={`text-xs px-2.5 py-1 rounded-full border ${sel.permisos.includes(p.slug) ? 'bg-brand-100 text-brand-800 border-brand-300' : 'bg-white text-ink-soft border-ink/15'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ))}
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
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium">Nuevo rol</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Nombre *</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Encargado de turno" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Descripción</label>
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Para qué sirve este rol" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Creando…' : 'Crear rol'}
          </button>
        </div>
      </div>
    </div>
  );
}
