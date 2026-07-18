// Marcas — ABM de marcas del grupo. Crear/editar/eliminar marcas y asignar
// cada local a su marca. Una marca agrupa locales dentro del tenant.
//
// Look Command Center (17-jul): sin cards, sin pills, sin botones sólidos.
// Filas de marca con hairline abajo, chips de locales como texto tinted,
// tabla de locales → marca en listing plano.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Store, Check, X } from 'lucide-react';
import {
  listMarcas, listLocalesConMarca, crearMarca, actualizarMarca, eliminarMarca, setMarcaDeLocal,
  type Marca, type LocalConMarca,
} from '@/lib/marcasService';
import { SectionHeader } from '@/components/primitives';

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
    setLocales((prev) => prev.map((l) => (l.id === localId ? { ...l, marca_id: marcaId } : l)));
  }

  if (cargando) return <div className="text-dim-300 font-mono text-xs uppercase tracking-widest2 py-8">Cargando marcas…</div>;

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">04 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">Marcas y locales</h1>
      </div>

      {/* ── Marcas del grupo ────────────────────────────────── */}
      <section>
        <SectionHeader
          code="B0"
          label="Marcas del grupo"
          count={marcas.length}
          right={
            !creando ? (
              <button
                onClick={() => setCreando(true)}
                className="text-brand-300 hover:text-brand-200 font-mono uppercase tracking-widest2 text-xs inline-flex items-center gap-1.5 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Nueva marca
              </button>
            ) : null
          }
        />

        <p className="text-xs text-dim-400 mt-3 mb-1">
          Cada marca agrupa locales. El menú, el branding y los reportes se separan por marca.
        </p>

        {creando && (
          <div className="py-4 flex flex-wrap items-end gap-4 border-b border-carbon-600">
            <div className="min-w-[200px]">
              <p className="label-sys mb-1.5">Nombre</p>
              <input
                value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} autoFocus
                placeholder="Ej: Neko Sushi"
                className="w-full py-1.5 text-sm placeholder:text-dim-400"
              />
            </div>
            <div>
              <p className="label-sys mb-1.5">Color</p>
              <input type="color" value={nuevoColor} onChange={(e) => setNuevoColor(e.target.value)}
                className="h-8 w-14 cursor-pointer" />
            </div>
            <div className="flex items-center gap-4 ml-auto pb-1">
              <button
                onClick={() => { setCreando(false); setNuevoNombre(''); }}
                className="text-dim-300 hover:text-dim-100 font-mono uppercase tracking-widest2 text-xs transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => void onCrear()}
                className="text-brand-300 hover:text-brand-200 font-mono uppercase tracking-widest2 text-xs inline-flex items-center gap-1 transition-colors"
              >
                Crear <span>→</span>
              </button>
            </div>
          </div>
        )}

        {/* Marcas — filas separadas por hairline. */}
        <div>
          {marcas.map((m) => {
            const ls = localesDeMarca(m.id);
            const editando = editId === m.id;
            return (
              <div key={m.id} className="group py-4 border-b border-carbon-600">
                {editando ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)}
                      className="h-8 w-14 cursor-pointer" />
                    <input value={editNombre} onChange={(e) => setEditNombre(e.target.value)} autoFocus
                      className="flex-1 min-w-[200px] py-1.5 text-sm" />
                    <div className="flex items-center gap-4 ml-auto pb-1">
                      <button
                        onClick={() => setEditId(null)}
                        className="text-dim-300 hover:text-dim-100 font-mono uppercase tracking-widest2 text-xs inline-flex items-center gap-1 transition-colors"
                      >
                        <X className="h-3 w-3" /> Cancelar
                      </button>
                      <button
                        onClick={() => void onGuardarEdicion()}
                        className="text-brand-300 hover:text-brand-200 font-mono uppercase tracking-widest2 text-xs inline-flex items-center gap-1 transition-colors"
                      >
                        <Check className="h-3 w-3" /> Guardar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      {/* Swatch del color — chico, sin border box. */}
                      <span
                        className="h-6 w-6 rounded-sm shrink-0"
                        style={{ background: m.color_primary ?? COLOR_DEFAULT }}
                        title={m.color_primary ?? COLOR_DEFAULT}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[15px] font-medium text-dim-50 truncate">{m.nombre}</div>
                        <div className="text-[11px] font-mono uppercase tracking-widest2 text-dim-400 mt-0.5">
                          {ls.length} {ls.length === 1 ? 'LOCAL' : 'LOCALES'}
                        </div>
                      </div>
                      {/* Acciones invisibles hasta hover. */}
                      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => abrirEdicion(m)}
                          title="Editar"
                          className="h-7 w-7 rounded-sm text-dim-300 hover:text-brand-300 hover:bg-brand-400/10 inline-flex items-center justify-center transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => void onEliminar(m)}
                          title="Eliminar"
                          className="h-7 w-7 rounded-sm text-dim-300 hover:text-crit hover:bg-crit/10 inline-flex items-center justify-center transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {/* Chips locales — solo texto mono tinted, sin pill. */}
                    {ls.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 pl-9 text-[11px] font-mono">
                        {ls.map((l) => (
                          <span key={l.id} className="inline-flex items-center gap-1.5 text-dim-300">
                            <Store className="h-3 w-3 text-dim-400" /> {l.nombre}
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

      {/* ── Asignar locales → marca ────────────────────────── */}
      <section>
        <SectionHeader
          code="B1"
          label="Locales → marca"
          count={locales.length}
        />
        <p className="text-xs text-dim-400 mt-3 mb-2">A qué marca pertenece cada sucursal.</p>

        <div>
          {locales.map((l) => (
            <div key={l.id} className="flex items-center gap-4 py-3 border-b border-carbon-600">
              <Store className="h-3.5 w-3.5 text-dim-400 shrink-0" />
              <span className="flex-1 text-sm text-dim-50 truncate">{l.nombre}</span>
              <select
                value={l.marca_id ?? ''}
                onChange={(e) => void onAsignarLocal(l.id, e.target.value === '' ? null : Number(e.target.value))}
                className="text-[11px] font-mono uppercase tracking-widest2 text-brand-300 py-1 min-w-[160px] max-w-[240px]"
              >
                <option value="">— Sin marca —</option>
                {marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </div>
          ))}
        </div>
        {sinMarca.length > 0 && (
          <p className="text-[11px] font-mono uppercase tracking-widest2 text-warn mt-3">
            ⚠ {sinMarca.length} LOCAL(ES) SIN MARCA ASIGNADA
          </p>
        )}
      </section>
    </div>
  );
}
