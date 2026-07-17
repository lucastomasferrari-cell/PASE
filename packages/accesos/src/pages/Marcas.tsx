// Marcas — ABM de marcas del grupo. Crear/editar/eliminar marcas y asignar
// cada local a su marca. Una marca agrupa locales dentro del tenant.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Store, Check, X } from 'lucide-react';
import {
  listMarcas, listLocalesConMarca, crearMarca, actualizarMarca, eliminarMarca, setMarcaDeLocal,
  type Marca, type LocalConMarca,
} from '@/lib/marcasService';

const COLOR_DEFAULT = '#75AADB';

export function Marcas() {
  const [marcas, setMarcas] = useState<Marca[]>([]);
  const [locales, setLocales] = useState<LocalConMarca[]>([]);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoColor, setNuevoColor] = useState(COLOR_DEFAULT);
  const [editId, setEditId] = useState<number | null>(null);
  const [editNombre, setEditNombre] = useState('');
  const [editColor, setEditColor] = useState(COLOR_DEFAULT);

  async function recargar() {
    setCargando(true);
    const [m, l] = await Promise.all([listMarcas(), listLocalesConMarca()]);
    if (m.error) toast.error(m.error); else setMarcas(m.data);
    if (l.error) toast.error(l.error); else setLocales(l.data);
    setCargando(false);
  }

  useEffect(() => { void recargar(); }, []);

  function localesDeMarca(marcaId: number): LocalConMarca[] {
    return locales.filter((l) => l.marca_id === marcaId);
  }
  const sinMarca = locales.filter((l) => l.marca_id === null);

  async function onCrear() {
    if (!nuevoNombre.trim()) { toast.error('Poné un nombre'); return; }
    const { error } = await crearMarca({ nombre: nuevoNombre, color: nuevoColor });
    if (error) { toast.error(error); return; }
    toast.success('Marca creada');
    setNuevoNombre(''); setNuevoColor(COLOR_DEFAULT); setCreando(false);
    void recargar();
  }

  function abrirEdicion(m: Marca) {
    setEditId(m.id); setEditNombre(m.nombre); setEditColor(m.color_primary ?? COLOR_DEFAULT);
  }

  async function onGuardarEdicion() {
    if (editId === null) return;
    const { error } = await actualizarMarca(editId, { nombre: editNombre.trim(), color_primary: editColor });
    if (error) { toast.error(error); return; }
    toast.success('Marca actualizada');
    setEditId(null);
    void recargar();
  }

  async function onEliminar(m: Marca) {
    if (!confirm(`¿Eliminar la marca "${m.nombre}"? Sus locales quedan sin marca (se reasignan después).`)) return;
    const { error } = await eliminarMarca(m.id);
    if (error) { toast.error(error); return; }
    toast.success('Marca eliminada');
    void recargar();
  }

  async function onAsignarLocal(localId: number, marcaId: number | null) {
    const { error } = await setMarcaDeLocal(localId, marcaId);
    if (error) { toast.error(error); return; }
    // Optimista
    setLocales((prev) => prev.map((l) => (l.id === localId ? { ...l, marca_id: marcaId } : l)));
  }

  if (cargando) return <div className="text-dim-300 text-sm py-8">Cargando marcas…</div>;

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">04 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">Marcas y locales</h1>
      </div>
      {/* ── Marcas ───────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-medium">Marcas del grupo</h2>
            <p className="text-xs text-dim-300">Cada marca agrupa locales. El menú, el branding y los reportes se separan por marca.</p>
          </div>
          {!creando && (
            <button onClick={() => setCreando(true)}
              className="inline-flex items-center gap-1.5 rounded-sm bg-brand-400 hover:bg-brand-500 text-white px-3 py-2 text-sm font-medium">
              <Plus className="h-4 w-4" /> Nueva marca
            </button>
          )}
        </div>

        {creando && (
          <div className="border-t border-b border-carbon-600 bg-transparent p-4 mb-3 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-dim-300">Nombre</label>
              <input value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} autoFocus
                placeholder="Ej: Neko Sushi"
                className="block w-56 rounded-sm border border-carbon-500 px-3 py-2 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-dim-300">Color</label>
              <input type="color" value={nuevoColor} onChange={(e) => setNuevoColor(e.target.value)}
                className="block h-9 w-14 rounded-sm border border-carbon-500 cursor-pointer" />
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <button onClick={() => { setCreando(false); setNuevoNombre(''); }}
                className="rounded-sm border border-carbon-500 px-3 py-2 text-sm hover:bg-carbon-700">Cancelar</button>
              <button onClick={() => void onCrear()}
                className="rounded-sm bg-brand-400 hover:bg-brand-500 text-white px-3 py-2 text-sm font-medium">Crear</button>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {marcas.map((m) => {
            const ls = localesDeMarca(m.id);
            const editando = editId === m.id;
            return (
              <div key={m.id} className="border-t border-b border-carbon-600 bg-transparent p-4">
                {editando ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)}
                        className="h-8 w-10 rounded border border-carbon-500 cursor-pointer shrink-0" />
                      <input value={editNombre} onChange={(e) => setEditNombre(e.target.value)} autoFocus
                        className="flex-1 rounded-sm border border-carbon-500 px-3 py-1.5 text-sm" />
                    </div>
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => setEditId(null)} className="inline-flex items-center gap-1 rounded-sm border border-carbon-500 px-2.5 py-1.5 text-xs hover:bg-carbon-700"><X className="h-3.5 w-3.5" /> Cancelar</button>
                      <button onClick={() => void onGuardarEdicion()} className="inline-flex items-center gap-1 rounded-sm bg-brand-400 hover:bg-brand-500 text-white px-2.5 py-1.5 text-xs font-medium"><Check className="h-3.5 w-3.5" /> Guardar</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2.5">
                      <span className="h-7 w-7 rounded-sm shrink-0 border border-carbon-600" style={{ background: m.color_primary ?? COLOR_DEFAULT }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{m.nombre}</div>
                        <div className="text-[11px] text-dim-300">{ls.length} {ls.length === 1 ? 'local' : 'locales'}</div>
                      </div>
                      <button onClick={() => abrirEdicion(m)} title="Editar" className="text-dim-300 hover:text-brand-400-300 p-1"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => void onEliminar(m)} title="Eliminar" className="text-dim-300 hover:text-crit p-1"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {ls.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {ls.map((l) => (
                          <span key={l.id} className="inline-flex items-center gap-1 rounded-full bg-brand-400/10 text-brand-400 px-2 py-0.5 text-[11px]">
                            <Store className="h-3 w-3" /> {l.nombre}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Asignar locales ──────────────────────────────────── */}
      <section>
        <h2 className="text-base font-medium mb-1">Locales → marca</h2>
        <p className="text-xs text-dim-300 mb-3">A qué marca pertenece cada sucursal.</p>
        <div className="border-t border-b border-carbon-600 bg-transparent divide-y divide-carbon-600">
          {locales.map((l) => (
            <div key={l.id} className="flex items-center gap-3 px-4 py-2.5">
              <Store className="h-4 w-4 text-dim-300 shrink-0" />
              <span className="flex-1 text-sm truncate">{l.nombre}</span>
              <select
                value={l.marca_id ?? ''}
                onChange={(e) => void onAsignarLocal(l.id, e.target.value === '' ? null : Number(e.target.value))}
                className="rounded-sm border border-carbon-500 px-2.5 py-1.5 text-sm bg-carbon-800 max-w-[200px]"
              >
                <option value="">— Sin marca —</option>
                {marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </div>
          ))}
        </div>
        {sinMarca.length > 0 && (
          <p className="text-[11px] text-amber-700 mt-2">{sinMarca.length} local(es) sin marca asignada.</p>
        )}
      </section>
    </div>
  );
}
