// Editor de mesas / sectores del salón — sección del admin de MESA.
// Carga el salón real (número, sector/zona, capacidad, reservable), que
// alimenta el motor de reservas (asignación por mesa + selector de sector que
// ve el cliente). Los sectores se ELIGEN de una lista (no texto libre) para
// evitar duplicados por typo; se pueden renombrar en bloque.
// Escribe directo en `mesas` (RLS: dueño/admin con permiso comanda.mesas.gestionar).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, LayoutGrid, Pencil, Check, X } from 'lucide-react';
import { db } from '@/lib/supabase';

interface Mesa { id: number; numero: string; zona: string | null; capacidad: number | null; reservable: boolean }
const NUEVO = '__nuevo__';

export function AdminMesas({ localId, tenantId }: { localId: number; tenantId: string }) {
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [cargando, setCargando] = useState(true);
  const [numero, setNumero] = useState('');
  const [capacidad, setCapacidad] = useState('4');
  const [sectorSel, setSectorSel] = useState<string>('');
  const [sectorNuevo, setSectorNuevo] = useState('');
  const [agregando, setAgregando] = useState(false);
  const [renombrar, setRenombrar] = useState<string | null>(null);
  const [renombreVal, setRenombreVal] = useState('');

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await db()
      .from('mesas')
      .select('id, numero, zona, capacidad, reservable')
      .eq('local_id', localId).is('deleted_at', null)
      .order('zona', { ascending: true }).order('numero', { ascending: true });
    if (error) toast.error('No se pudieron cargar las mesas: ' + error.message);
    setMesas((data ?? []) as Mesa[]);
    setCargando(false);
  }, [localId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const sectores = useMemo(
    () => Array.from(new Set(mesas.map((m) => m.zona).filter(Boolean))).sort() as string[],
    [mesas],
  );

  const porSector = useMemo(() => {
    const map = new Map<string, Mesa[]>();
    for (const m of mesas) {
      const k = m.zona || 'Sin sector';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [mesas]);

  async function agregar() {
    if (!numero.trim()) { toast.error('Poné un número/nombre de mesa'); return; }
    const zona = (sectorSel === NUEVO ? sectorNuevo : sectorSel).trim() || null;
    if (!zona) { toast.error('Elegí o creá un sector'); return; }
    setAgregando(true);
    try {
      const { data, error } = await db().from('mesas').insert({
        tenant_id: tenantId, local_id: localId,
        numero: numero.trim(), zona,
        capacidad: capacidad ? Number(capacidad) : null,
        forma: 'cuadrado', reservable: true,
      }).select('id, numero, zona, capacidad, reservable').single();
      if (error) { toast.error('No se pudo agregar: ' + error.message); return; }
      setMesas((prev) => [...prev, data as Mesa]);
      setNumero('');
      setSectorSel(zona); setSectorNuevo('');
    } finally { setAgregando(false); }
  }

  async function patch(id: number, campo: Partial<Mesa>) {
    setMesas((prev) => prev.map((m) => m.id === id ? { ...m, ...campo } : m));
    const { error } = await db().from('mesas').update(campo).eq('id', id);
    if (error) { toast.error('No se pudo guardar: ' + error.message); void cargar(); }
  }

  async function eliminar(id: number) {
    if (!window.confirm('¿Eliminar esta mesa?')) return;
    setMesas((prev) => prev.filter((m) => m.id !== id));
    const { error } = await db().from('mesas').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); void cargar(); }
  }

  // Renombra un sector: actualiza TODAS las mesas de esa zona de una (corrige
  // duplicados por typo y lo que ve el cliente).
  async function guardarRenombre(viejo: string) {
    const nuevo = renombreVal.trim();
    setRenombrar(null);
    if (!nuevo || nuevo === viejo) return;
    setMesas((prev) => prev.map((m) => (m.zona === viejo ? { ...m, zona: nuevo } : m)));
    const { error } = await db().from('mesas').update({ zona: nuevo })
      .eq('local_id', localId).eq('zona', viejo);
    if (error) { toast.error('No se pudo renombrar: ' + error.message); void cargar(); }
    else toast.success(`Sector renombrado a "${nuevo}"`);
  }

  if (cargando) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-ink-muted" /></div>;

  const totalCubiertos = mesas.filter((m) => m.reservable).reduce((s, m) => s + (m.capacidad ?? 0), 0);
  const creandoSector = sectorSel === NUEVO || sectores.length === 0;

  return (
    <div className="mt-6 max-w-3xl space-y-5 pb-10">
      {/* Cargar mesa */}
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <p className="font-medium flex items-center gap-2"><LayoutGrid className="h-4 w-4 text-brand-500" /> Cargar mesa</p>
        <p className="text-xs text-ink-muted mt-1 mb-3">El sector es lo que el cliente elige al reservar (Barra, Salón, Terraza, Privado…). Elegí uno o creá uno nuevo.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Número / nombre" className="w-28">
            <input value={numero} onChange={(e) => setNumero(e.target.value)}
                   placeholder="ej. 12" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Field>
          <Field label="Sector" className="w-44">
            {creandoSector ? (
              <div className="flex items-center gap-1">
                <input value={sectorNuevo} onChange={(e) => setSectorNuevo(e.target.value)} autoFocus={sectores.length > 0}
                       placeholder="ej. Salón" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                {sectores.length > 0 && (
                  <button onClick={() => { setSectorSel(''); setSectorNuevo(''); }} title="Elegir uno existente"
                          className="text-ink-muted hover:text-ink p-1.5"><X className="h-4 w-4" /></button>
                )}
              </div>
            ) : (
              <select value={sectorSel} onChange={(e) => setSectorSel(e.target.value)}
                      className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
                <option value="">Elegí un sector…</option>
                {sectores.map((s) => <option key={s} value={s}>{s}</option>)}
                <option value={NUEVO}>＋ Nuevo sector…</option>
              </select>
            )}
          </Field>
          <Field label="Capacidad" className="w-24">
            <input type="number" min={1} value={capacidad} onChange={(e) => setCapacidad(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Field>
          <button onClick={() => void agregar()} disabled={agregando}
                  className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
            {agregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Agregar
          </button>
        </div>
      </div>

      {/* Sectores (resumen + renombrar) */}
      {sectores.length > 0 && (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
          <p className="font-medium mb-1">Sectores <span className="text-ink-muted font-normal">({sectores.length})</span></p>
          <p className="text-xs text-ink-muted mb-3">Lo que ve el cliente al elegir dónde sentarse. Renombralos para corregir duplicados.</p>
          <div className="flex flex-wrap gap-2">
            {porSector.map(([zona, ms]) => {
              const cub = ms.filter((m) => m.reservable).reduce((s, m) => s + (m.capacidad ?? 0), 0);
              const esRen = renombrar === zona;
              return (
                <div key={zona} className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 bg-ink/5 px-2.5 py-1.5 text-sm">
                  {esRen ? (
                    <>
                      <input value={renombreVal} autoFocus onChange={(e) => setRenombreVal(e.target.value)}
                             onKeyDown={(e) => { if (e.key === 'Enter') void guardarRenombre(zona); if (e.key === 'Escape') setRenombrar(null); }}
                             className="w-28 rounded border border-ink/15 px-1.5 py-0.5 text-sm" />
                      <button onClick={() => void guardarRenombre(zona)} className="text-emerald-600 hover:text-emerald-700 p-0.5"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setRenombrar(null)} className="text-ink-muted hover:text-ink p-0.5"><X className="h-4 w-4" /></button>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{zona}</span>
                      <span className="text-ink-muted text-xs">· {ms.length} mesa{ms.length !== 1 ? 's' : ''} · {cub} cub.</span>
                      {zona !== 'Sin sector' && (
                        <button onClick={() => { setRenombrar(zona); setRenombreVal(zona); }} title="Renombrar sector"
                                className="text-ink-muted hover:text-brand-600 p-0.5 ml-0.5"><Pencil className="h-3.5 w-3.5" /></button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mesas del salón */}
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
        <div className="px-5 py-3 border-b border-ink/5 flex items-center justify-between">
          <p className="font-medium">Mesas del salón <span className="text-ink-muted font-normal">({mesas.length})</span></p>
          <p className="text-xs text-ink-muted">{totalCubiertos} cubiertos reservables</p>
        </div>
        {mesas.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-muted">Todavía no hay mesas. Cargá el salón arriba para habilitar la asignación por mesa y los sectores.</p>
        ) : (
          <div className="divide-y divide-ink/5">
            <div className="grid grid-cols-[1fr_1.4fr_0.8fr_auto_auto] gap-3 px-5 py-2 text-[11px] uppercase tracking-wide text-ink-muted font-medium">
              <span>Mesa</span><span>Sector</span><span>Capac.</span><span>Reservable</span><span></span>
            </div>
            {mesas.map((m) => (
              <div key={m.id} className="grid grid-cols-[1fr_1.4fr_0.8fr_auto_auto] gap-3 px-5 py-2.5 items-center">
                <input defaultValue={m.numero} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.numero) void patch(m.id, { numero: v }); }}
                       className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <select value={m.zona ?? ''} onChange={(e) => void patch(m.id, { zona: e.target.value || null })}
                        className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm bg-white">
                  {m.zona == null && <option value="">Sin sector</option>}
                  {sectores.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <input type="number" min={1} defaultValue={m.capacidad ?? ''} onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== m.capacidad) void patch(m.id, { capacidad: v }); }}
                       className="w-16 rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <Toggle checked={m.reservable} onChange={(v) => void patch(m.id, { reservable: v })} />
                <button onClick={() => void eliminar(m.id)} className="text-ink-muted hover:text-red-500 p-1" title="Eliminar"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <div className={`space-y-1 ${className ?? ''}`}><label className="text-xs font-medium text-ink-soft">{label}</label>{children}</div>;
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
            className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${checked ? 'bg-brand-500' : 'bg-ink/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}
