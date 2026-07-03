// Editor de mesas / sectores del salón — sección del admin de MESA.
// Carga el salón real (número, sector/zona, capacidad, forma, reservable), que
// alimenta el motor de reservas (asignación por mesa + selector de sector que
// ve el cliente). Los sectores se ELIGEN de una lista (no texto libre) para
// evitar duplicados por typo; se pueden renombrar en bloque.
// Acá también vive la config de asignación que depende de las mesas: "Combinar
// mesas" y los límites (mín/máx) por sector — se persisten en
// `comanda_local_settings` en el momento (sin botón Guardar aparte).
// Escribe directo en `mesas` (RLS: dueño/admin con permiso comanda.mesas.gestionar).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, LayoutGrid, Pencil, Check, X, Link2 } from 'lucide-react';
import { db } from '@/lib/supabase';

type Forma = 'cuadrado' | 'redondo' | 'rectangular';
interface Mesa { id: number; numero: string; zona: string | null; capacidad: number | null; forma: Forma; reservable: boolean }
interface Settings { id: number; permiteCombinar: boolean; limites: { zona: string; min: string; max: string }[] }
interface Combo { id: number; nombre: string | null; mesa_ids: number[]; activa: boolean }
const NUEVO = '__nuevo__';
const FORMAS: { value: Forma; label: string }[] = [
  { value: 'cuadrado', label: 'Cuadrada' },
  { value: 'redondo', label: 'Redonda' },
  { value: 'rectangular', label: 'Rectangular' },
];

export function AdminMesas({ localId, tenantId }: { localId: number; tenantId: string }) {
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cargando, setCargando] = useState(true);
  const [numero, setNumero] = useState('');
  const [capacidad, setCapacidad] = useState('4');
  const [forma, setForma] = useState<Forma>('cuadrado');
  const [sectorSel, setSectorSel] = useState<string>('');
  const [sectorNuevo, setSectorNuevo] = useState('');
  const [agregando, setAgregando] = useState(false);
  const [renombrar, setRenombrar] = useState<string | null>(null);
  const [renombreVal, setRenombreVal] = useState('');
  // Grupos combinables (adyacencia): una fila ordenada de mesas pegables; el
  // motor junta las que estén libres y contiguas. La capacidad la calcula solo.
  const [combos, setCombos] = useState<Combo[]>([]);
  const [comboSel, setComboSel] = useState<number[]>([]);
  const [comboNombre, setComboNombre] = useState('');
  const [comboAgregando, setComboAgregando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await db()
      .from('mesas')
      .select('id, numero, zona, capacidad, forma, reservable')
      .eq('local_id', localId).is('deleted_at', null)
      .order('zona', { ascending: true }).order('numero', { ascending: true });
    if (error) toast.error('No se pudieron cargar las mesas: ' + error.message);
    setMesas((data ?? []) as Mesa[]);

    // Config de asignación que vive junto a las mesas (combinar + límites por sector).
    const { data: sData } = await db()
      .from('comanda_local_settings')
      .select('id, reservas_permite_combinar, reservas_zonas_limites')
      .eq('local_id', localId).maybeSingle();
    if (sData) {
      const s = sData as { id: number; reservas_permite_combinar: boolean | null; reservas_zonas_limites: Array<{ zona: string; min: number; max: number }> | null };
      const zl = s.reservas_zonas_limites ?? [];
      setSettings({
        id: s.id,
        permiteCombinar: s.reservas_permite_combinar == null ? true : Boolean(s.reservas_permite_combinar),
        limites: zl.map((z) => ({ zona: z.zona, min: String(z.min ?? ''), max: String(z.max ?? '') })),
      });
    } else {
      setSettings(null);
    }

    // Grupos combinables (el motor arma tramos contiguos libres dentro de cada uno).
    const { data: cData, error: cErr } = await db()
      .from('reservas_combinaciones')
      .select('id, nombre, mesa_ids, activa')
      .eq('local_id', localId).is('deleted_at', null).order('id');
    if (cErr) toast.error('No se pudieron cargar los grupos: ' + cErr.message);
    setCombos((cData ?? []).map((c) => ({
      id: c.id as number,
      nombre: (c.nombre ?? null) as string | null,
      mesa_ids: ((c.mesa_ids ?? []) as number[]).map(Number),
      activa: Boolean(c.activa),
    })));
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
        forma, reservable: true,
      }).select('id, numero, zona, capacidad, forma, reservable').single();
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

  // Persiste el array de límites (solo los pares zona+min+max completos, con el
  // shape que lee la RPC: { zona, min, max } numérico). Guarda en el momento.
  async function persistirLimites(limites: Settings['limites']) {
    if (!settings) return;
    const cleaned = limites
      .filter((z) => z.zona.trim() && z.min !== '' && z.max !== '')
      .map((z) => ({ zona: z.zona.trim(), min: Number(z.min), max: Number(z.max) }));
    const { error } = await db().from('comanda_local_settings')
      .update({ reservas_zonas_limites: cleaned }).eq('id', settings.id);
    if (error) toast.error('No se pudieron guardar los límites: ' + error.message);
  }

  // Toggle "Combinar mesas" — estado local + persistencia inmediata.
  async function toggleCombinar(v: boolean) {
    if (!settings) return;
    setSettings({ ...settings, permiteCombinar: v });
    const { error } = await db().from('comanda_local_settings')
      .update({ reservas_permite_combinar: v }).eq('id', settings.id);
    if (error) toast.error('No se pudo guardar: ' + error.message);
  }

  // Actualiza mín/máx de un sector (por nombre exacto) y persiste el array entero.
  function setLimite(zona: string, campo: 'min' | 'max', valor: string) {
    setSettings((prev) => {
      if (!prev) return prev;
      const existe = prev.limites.some((z) => z.zona === zona);
      const limites = existe
        ? prev.limites.map((z) => z.zona === zona ? { ...z, [campo]: valor } : z)
        : [...prev.limites, { zona, min: campo === 'min' ? valor : '', max: campo === 'max' ? valor : '' }];
      return { ...prev, limites };
    });
  }
  function limiteDe(zona: string): { min: string; max: string } {
    const z = settings?.limites.find((l) => l.zona === zona);
    return { min: z?.min ?? '', max: z?.max ?? '' };
  }

  // Renombra un sector: actualiza TODAS las mesas de esa zona de una (corrige
  // duplicados por typo y lo que ve el cliente). También renombra su límite para
  // que no quede huérfano.
  async function guardarRenombre(viejo: string) {
    const nuevo = renombreVal.trim();
    setRenombrar(null);
    if (!nuevo || nuevo === viejo) return;
    setMesas((prev) => prev.map((m) => (m.zona === viejo ? { ...m, zona: nuevo } : m)));
    const { error } = await db().from('mesas').update({ zona: nuevo })
      .eq('local_id', localId).eq('zona', viejo);
    if (error) { toast.error('No se pudo renombrar: ' + error.message); void cargar(); return; }
    toast.success(`Sector renombrado a "${nuevo}"`);
    // Renombrar el límite del sector (si tenía) para no orfanarlo.
    if (settings) {
      const renombrados = settings.limites.map((z) => z.zona === viejo ? { ...z, zona: nuevo } : z);
      setSettings({ ...settings, limites: renombrados });
      await persistirLimites(renombrados);
    }
  }

  // Alterna una mesa dentro de la selección de la combinación en armado.
  function toggleComboMesa(id: number) {
    setComboSel((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  const nombreDeMesa = useCallback(
    (id: number) => mesas.find((m) => m.id === id)?.numero ?? `#${id}`,
    [mesas],
  );
  // Capacidad máxima del grupo entero (suma de sus mesas) — solo informativa.
  const capacidadDeGrupo = useCallback(
    (mesaIds: number[]) => mesaIds.reduce((s, id) => s + (mesas.find((m) => m.id === id)?.capacidad ?? 0), 0),
    [mesas],
  );

  async function agregarCombo() {
    if (comboSel.length < 2) { toast.error('Elegí al menos 2 mesas'); return; }
    setComboAgregando(true);
    try {
      const { data, error } = await db().from('reservas_combinaciones').insert({
        tenant_id: tenantId, local_id: localId,
        nombre: comboNombre.trim() || null,
        mesa_ids: comboSel, activa: true,
      }).select('id, nombre, mesa_ids, activa').single();
      if (error) { toast.error('No se pudo crear el grupo: ' + error.message); return; }
      const c = data as { id: number; nombre: string | null; mesa_ids: number[]; activa: boolean };
      setCombos((prev) => [...prev, {
        id: c.id, nombre: c.nombre ?? null, mesa_ids: (c.mesa_ids ?? []).map(Number),
        activa: Boolean(c.activa),
      }]);
      setComboSel([]); setComboNombre('');
      toast.success('Grupo combinable creado');
    } finally { setComboAgregando(false); }
  }

  async function toggleComboActiva(id: number, v: boolean) {
    setCombos((prev) => prev.map((c) => c.id === id ? { ...c, activa: v } : c));
    const { error } = await db().from('reservas_combinaciones').update({ activa: v }).eq('id', id);
    if (error) { toast.error('No se pudo guardar: ' + error.message); void cargar(); }
  }

  async function eliminarCombo(id: number) {
    if (!window.confirm('¿Eliminar este grupo combinable?')) return;
    setCombos((prev) => prev.filter((c) => c.id !== id));
    const { error } = await db().from('reservas_combinaciones')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); void cargar(); }
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
          <Field label="Forma" className="w-32">
            <select value={forma} onChange={(e) => setForma(e.target.value as Forma)}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              {FORMAS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
          <button onClick={() => void agregar()} disabled={agregando}
                  className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
            {agregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Agregar
          </button>
        </div>
      </div>

      {/* Sectores (resumen + renombrar + combinar + límites) */}
      {sectores.length > 0 && (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
          <p className="font-medium mb-1">Sectores <span className="text-ink-muted font-normal">({sectores.length})</span></p>
          <p className="text-xs text-ink-muted mb-3">Lo que ve el cliente al elegir dónde sentarse. Renombralos para corregir duplicados. Podés poner un mín/máx de personas por reserva en cada sector (vacío = sin límite).</p>

          {settings && (
            <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-ink/5">
              <div>
                <p className="text-sm font-medium">Combinar mesas</p>
                <p className="text-xs text-ink-muted mt-0.5">Si un grupo no entra en una mesa, junta dos (ej. dos de 4 para un grupo de 6).</p>
              </div>
              <div className="shrink-0"><Toggle checked={settings.permiteCombinar} onChange={(v) => void toggleCombinar(v)} /></div>
            </div>
          )}

          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-1 text-[11px] uppercase tracking-wide text-ink-muted font-medium">
              <span>Sector</span><span className="w-20 text-center">mín</span><span className="w-20 text-center">máx</span>
            </div>
            {porSector.map(([zona, ms]) => {
              const cub = ms.filter((m) => m.reservable).reduce((s, m) => s + (m.capacidad ?? 0), 0);
              const esRen = renombrar === zona;
              const lim = limiteDe(zona);
              const esSinSector = zona === 'Sin sector';
              return (
                <div key={zona} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {esRen ? (
                      <>
                        <input value={renombreVal} autoFocus onChange={(e) => setRenombreVal(e.target.value)}
                               onKeyDown={(e) => { if (e.key === 'Enter') void guardarRenombre(zona); if (e.key === 'Escape') setRenombrar(null); }}
                               className="w-32 rounded border border-ink/15 px-1.5 py-1 text-sm" />
                        <button onClick={() => void guardarRenombre(zona)} className="text-emerald-600 hover:text-emerald-700 p-0.5"><Check className="h-4 w-4" /></button>
                        <button onClick={() => setRenombrar(null)} className="text-ink-muted hover:text-ink p-0.5"><X className="h-4 w-4" /></button>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-sm truncate">{zona}</span>
                        <span className="text-ink-muted text-xs shrink-0">· {ms.length} mesa{ms.length !== 1 ? 's' : ''} · {cub} cub.</span>
                        {!esSinSector && (
                          <button onClick={() => { setRenombrar(zona); setRenombreVal(zona); }} title="Renombrar sector"
                                  className="text-ink-muted hover:text-brand-600 p-0.5 ml-0.5 shrink-0"><Pencil className="h-3.5 w-3.5" /></button>
                        )}
                      </>
                    )}
                  </div>
                  <input type="number" min={1} value={lim.min} disabled={!settings || esSinSector} placeholder="sin límite"
                         onChange={(e) => setLimite(zona, 'min', e.target.value)}
                         onBlur={() => { if (settings) void persistirLimites(settings.limites); }}
                         className="w-20 rounded-lg border border-ink/15 px-2 py-1.5 text-sm text-center disabled:bg-ink/5 disabled:text-ink-muted" />
                  <input type="number" min={1} value={lim.max} disabled={!settings || esSinSector} placeholder="sin límite"
                         onChange={(e) => setLimite(zona, 'max', e.target.value)}
                         onBlur={() => { if (settings) void persistirLimites(settings.limites); }}
                         className="w-20 rounded-lg border border-ink/15 px-2 py-1.5 text-sm text-center disabled:bg-ink/5 disabled:text-ink-muted" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grupos combinables (adyacencia) */}
      {mesas.length >= 2 && (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
          <p className="font-medium flex items-center gap-2"><Link2 className="h-4 w-4 text-brand-500" /> Grupos combinables</p>
          <p className="text-xs text-ink-muted mt-1 mb-4">Marcá las mesas de una fila o barra que se pueden pegar, <b>en el orden en que están</b> (de una punta a la otra). Cuando un grupo no entra en una mesa sola, el motor junta las mesas de esa fila que estén <b>libres y contiguas</b>, y suma su capacidad. Una mesa que no va en ningún grupo nunca se combina.</p>

          {/* Armar un grupo */}
          <div className="rounded-xl border border-ink/10 p-3 mb-4">
            <p className="text-xs font-medium text-ink-soft mb-2">Elegí las mesas de la fila, en orden</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {mesas.map((m) => {
                const pos = comboSel.indexOf(m.id);
                const sel = pos >= 0;
                return (
                  <button key={m.id} type="button" onClick={() => toggleComboMesa(m.id)}
                          className={`rounded-lg border px-2.5 py-1.5 text-sm inline-flex items-baseline gap-1 transition-colors ${sel ? 'bg-brand-500 border-brand-500 text-white' : 'border-ink/15 text-ink hover:border-brand-300'}`}>
                    {sel && <span className="text-[11px] font-semibold text-white/90">{pos + 1}.</span>}
                    <span className="font-medium">{m.numero}</span>
                    {m.zona && <span className={`text-[11px] ${sel ? 'text-white/70' : 'text-ink-muted'}`}>{m.zona}</span>}
                  </button>
                );
              })}
            </div>
            {comboSel.length >= 2 && (
              <p className="text-xs text-ink-muted mb-3">
                Fila: {comboSel.map((id) => nombreDeMesa(id)).join(' → ')} · capacidad máxima {capacidadDeGrupo(comboSel)} personas
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Nombre (opcional)" className="w-44">
                <input value={comboNombre} onChange={(e) => setComboNombre(e.target.value)}
                       placeholder="ej. Barra" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </Field>
              <button onClick={() => void agregarCombo()} disabled={comboAgregando || comboSel.length < 2}
                      className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
                {comboAgregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Agregar grupo
              </button>
            </div>
          </div>

          {/* Grupos existentes */}
          {combos.length === 0 ? (
            <p className="text-sm text-ink-muted">Todavía no hay grupos. Armá uno arriba marcando las mesas de una fila en orden (ej. toda la barra).</p>
          ) : (
            <div className="divide-y divide-ink/5">
              {combos.map((c) => (
                <div key={c.id} className="flex items-center gap-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
                    {c.nombre && <span className="text-sm font-medium text-ink mr-1">{c.nombre}:</span>}
                    {c.mesa_ids.map((mid, i) => (
                      <span key={mid} className="inline-flex items-center gap-1">
                        {i > 0 && <span className="text-ink-muted text-sm">+</span>}
                        <span className="rounded-md bg-ink/5 border border-ink/10 px-2 py-0.5 text-sm font-medium">{nombreDeMesa(mid)}</span>
                      </span>
                    ))}
                    <span className="text-ink-muted text-xs ml-1">· hasta {capacidadDeGrupo(c.mesa_ids)} personas</span>
                  </div>
                  <Toggle checked={c.activa} onChange={(v) => void toggleComboActiva(c.id, v)} />
                  <button onClick={() => void eliminarCombo(c.id)} className="text-ink-muted hover:text-red-500 p-1 shrink-0" title="Eliminar"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
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
            <div className="grid grid-cols-[1fr_1.4fr_0.8fr_1fr_auto_auto] gap-3 px-5 py-2 text-[11px] uppercase tracking-wide text-ink-muted font-medium">
              <span>Mesa</span><span>Sector</span><span>Capac.</span><span>Forma</span><span>Reservable</span><span></span>
            </div>
            {mesas.map((m) => (
              <div key={m.id} className="grid grid-cols-[1fr_1.4fr_0.8fr_1fr_auto_auto] gap-3 px-5 py-2.5 items-center">
                <input defaultValue={m.numero} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.numero) void patch(m.id, { numero: v }); }}
                       className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <select value={m.zona ?? ''} onChange={(e) => void patch(m.id, { zona: e.target.value || null })}
                        className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm bg-white">
                  {m.zona == null && <option value="">Sin sector</option>}
                  {sectores.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <input type="number" min={1} defaultValue={m.capacidad ?? ''} onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== m.capacidad) void patch(m.id, { capacidad: v }); }}
                       className="w-16 rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <select value={m.forma} onChange={(e) => void patch(m.id, { forma: e.target.value as Forma })}
                        className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm bg-white">
                  {FORMAS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
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
