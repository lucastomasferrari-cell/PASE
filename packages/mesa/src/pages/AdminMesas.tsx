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
import { Plus, Trash2, Loader2, LayoutGrid, X, Link2 } from 'lucide-react';
import { db } from '@/lib/supabase';

type Forma = 'cuadrado' | 'redondo' | 'rectangular';
interface Mesa { id: number; numero: string; zona: string | null; capacidad: number | null; min_personas: number | null; forma: Forma; reservable: boolean }
interface Settings { id: number; permiteCombinar: boolean; limites: { zona: string; min: string; max: string }[] }
interface Combo { id: number; nombre: string | null; mesa_ids: number[]; tipo: 'grupo' | 'fija'; min_personas: number | null; max_personas: number | null; max_sillas_vacias: number | null; activa: boolean }
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
  const [capMin, setCapMin] = useState('');
  const [forma, setForma] = useState<Forma>('cuadrado');
  const [sectorSel, setSectorSel] = useState<string>('');
  const [sectorNuevo, setSectorNuevo] = useState('');
  const [agregando, setAgregando] = useState(false);
  // Combinar mesas — dos modos (como Eat App):
  //  grupo = marcás las mesas de una fila; el motor arma el tramo contiguo libre.
  //  fija  = combinación exacta de mesas puntuales, con rango desde/hasta personas.
  const [combos, setCombos] = useState<Combo[]>([]);
  const [comboModo, setComboModo] = useState<'grupo' | 'fija'>('grupo');
  const [comboSel, setComboSel] = useState<number[]>([]);
  const [comboNombre, setComboNombre] = useState('');
  const [comboMin, setComboMin] = useState('');
  const [comboMax, setComboMax] = useState('');
  const [comboMaxVacias, setComboMaxVacias] = useState('');
  const [comboAgregando, setComboAgregando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await db()
      .from('mesas')
      .select('id, numero, zona, capacidad, min_personas, forma, reservable')
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

    // Combinaciones (grupos + fijas).
    const { data: cData, error: cErr } = await db()
      .from('reservas_combinaciones')
      .select('id, nombre, mesa_ids, tipo, min_personas, max_personas, max_sillas_vacias, activa')
      .eq('local_id', localId).is('deleted_at', null).order('id');
    if (cErr) toast.error('No se pudieron cargar las combinaciones: ' + cErr.message);
    setCombos((cData ?? []).map((c) => ({
      id: c.id as number,
      nombre: (c.nombre ?? null) as string | null,
      mesa_ids: ((c.mesa_ids ?? []) as number[]).map(Number),
      tipo: (c.tipo === 'fija' ? 'fija' : 'grupo') as 'grupo' | 'fija',
      min_personas: c.min_personas == null ? null : Number(c.min_personas),
      max_personas: c.max_personas == null ? null : Number(c.max_personas),
      max_sillas_vacias: c.max_sillas_vacias == null ? null : Number(c.max_sillas_vacias),
      activa: Boolean(c.activa),
    })));
    setCargando(false);
  }, [localId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const sectores = useMemo(
    () => Array.from(new Set(mesas.map((m) => m.zona).filter(Boolean))).sort() as string[],
    [mesas],
  );


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
        min_personas: capMin ? Number(capMin) : null,
        forma, reservable: true,
      }).select('id, numero, zona, capacidad, min_personas, forma, reservable').single();
      if (error) {
        const dup = error.code === '23505' || /duplicate key|uniq_mesas_numero/i.test(error.message);
        toast.error(dup
          ? `Ya existe una mesa "${numero.trim()}" en este local. Poné otro número/nombre.`
          : 'No se pudo agregar: ' + error.message);
        return;
      }
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

  // Toggle "Combinar mesas" — estado local + persistencia inmediata.
  async function toggleCombinar(v: boolean) {
    if (!settings) return;
    setSettings({ ...settings, permiteCombinar: v });
    const { error } = await db().from('comanda_local_settings')
      .update({ reservas_permite_combinar: v }).eq('id', settings.id);
    if (error) toast.error('No se pudo guardar: ' + error.message);
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
    let min: number | null = null, max: number | null = null, maxVacias: number | null = null;
    if (comboModo === 'fija') {
      min = comboMin.trim() ? Number(comboMin) : null;
      max = comboMax.trim() ? Number(comboMax) : null;
      if (min != null && max != null && min > max) { toast.error('El "desde" no puede ser mayor que el "hasta"'); return; }
    } else {
      maxVacias = comboMaxVacias.trim() ? Number(comboMaxVacias) : null;
    }
    // Para un grupo el orden importa (adyacencia): guardamos las mesas ordenadas
    // por su número/nombre, así "Banqueta 1..8" queda en secuencia física.
    const ids = comboModo === 'grupo'
      ? [...comboSel].sort((a, b) => nombreDeMesa(a).localeCompare(nombreDeMesa(b), 'es', { numeric: true }))
      : comboSel;
    setComboAgregando(true);
    try {
      const { data, error } = await db().from('reservas_combinaciones').insert({
        tenant_id: tenantId, local_id: localId,
        nombre: comboNombre.trim() || null,
        mesa_ids: ids, tipo: comboModo,
        min_personas: min, max_personas: max,
        max_sillas_vacias: maxVacias, activa: true,
      }).select('id, nombre, mesa_ids, tipo, min_personas, max_personas, max_sillas_vacias, activa').single();
      if (error) { toast.error('No se pudo crear la combinación: ' + error.message); return; }
      const c = data as { id: number; nombre: string | null; mesa_ids: number[]; tipo: string; min_personas: number | null; max_personas: number | null; max_sillas_vacias: number | null; activa: boolean };
      setCombos((prev) => [...prev, {
        id: c.id, nombre: c.nombre ?? null, mesa_ids: (c.mesa_ids ?? []).map(Number),
        tipo: c.tipo === 'fija' ? 'fija' : 'grupo',
        min_personas: c.min_personas == null ? null : Number(c.min_personas),
        max_personas: c.max_personas == null ? null : Number(c.max_personas),
        max_sillas_vacias: c.max_sillas_vacias == null ? null : Number(c.max_sillas_vacias),
        activa: Boolean(c.activa),
      }]);
      setComboSel([]); setComboNombre(''); setComboMin(''); setComboMax(''); setComboMaxVacias('');
      toast.success(comboModo === 'grupo' ? 'Grupo creado' : 'Combinación creada');
    } finally { setComboAgregando(false); }
  }

  async function toggleComboActiva(id: number, v: boolean) {
    setCombos((prev) => prev.map((c) => c.id === id ? { ...c, activa: v } : c));
    const { error } = await db().from('reservas_combinaciones').update({ activa: v }).eq('id', id);
    if (error) { toast.error('No se pudo guardar: ' + error.message); void cargar(); }
  }

  async function eliminarCombo(id: number) {
    if (!window.confirm('¿Eliminar esta combinación?')) return;
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
          <Field label="Mín." className="w-20">
            <input type="number" min={1} value={capMin} onChange={(e) => setCapMin(e.target.value)}
                   placeholder="1" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Field>
          <Field label="Máx." className="w-20">
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
            <div className="grid grid-cols-[1fr_1.4fr_0.55fr_0.55fr_1fr_auto_auto] gap-3 px-5 py-2 text-[11px] uppercase tracking-wide text-ink-muted font-medium">
              <span>Mesa</span><span>Sector</span><span>Mín</span><span>Máx</span><span>Forma</span><span>Reservable</span><span></span>
            </div>
            {mesas.map((m) => (
              <div key={m.id} className="grid grid-cols-[1fr_1.4fr_0.55fr_0.55fr_1fr_auto_auto] gap-3 px-5 py-2.5 items-center">
                <input defaultValue={m.numero} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.numero) void patch(m.id, { numero: v }); }}
                       className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <select value={m.zona ?? ''} onChange={(e) => void patch(m.id, { zona: e.target.value || null })}
                        className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm bg-white">
                  {m.zona == null && <option value="">Sin sector</option>}
                  {sectores.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <input type="number" min={1} defaultValue={m.min_personas ?? ''} placeholder="1" title="Mínimo de personas para usar esta mesa"
                       onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== m.min_personas) void patch(m.id, { min_personas: v }); }}
                       className="w-14 rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
                <input type="number" min={1} defaultValue={m.capacidad ?? ''} title="Máximo de personas (capacidad)"
                       onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== m.capacidad) void patch(m.id, { capacidad: v }); }}
                       className="w-14 rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
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

      {/* Combinar mesas — grupos + combinaciones fijas */}
      {mesas.length >= 2 && (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium flex items-center gap-2"><Link2 className="h-4 w-4 text-brand-500" /> Combinar mesas</p>
            {settings && <Toggle checked={settings.permiteCombinar} onChange={(v) => void toggleCombinar(v)} />}
          </div>
          <p className="text-xs text-ink-muted mt-1 mb-4">Dos formas de juntar mesas. Un <b>grupo</b>: marcás las mesas de una fila (la barra, los sillones) y el sistema arma solo la combinación libre que alcance. Podés poner un <b>máximo de sillas vacías</b> para no desperdiciar mesas rígidas. Una <b>combinación fija</b>: mesas puntuales para un rango de personas.</p>
          {settings && !settings.permiteCombinar && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">Las combinaciones están <b>desactivadas</b>: las reservas solo entran en mesas sueltas. Activá el interruptor de arriba para usarlas.</p>
          )}

          {/* Selector de modo */}
          <div className="inline-flex rounded-lg border border-ink/10 p-0.5 mb-3">
            {(['grupo', 'fija'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setComboModo(t)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${comboModo === t ? 'bg-brand-500 text-white' : 'text-ink-soft hover:text-ink'}`}>
                {t === 'grupo' ? 'Grupo' : 'Combinación fija'}
              </button>
            ))}
          </div>

          {/* Armar */}
          <div className="rounded-xl border border-ink/10 p-3 mb-4">
            <p className="text-xs font-medium text-ink-soft mb-2">
              {comboModo === 'grupo' ? 'Marcá las mesas que se pueden juntar' : 'Elegí las mesas exactas de la combinación'}
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {mesas.map((m) => {
                const sel = comboSel.includes(m.id);
                return (
                  <button key={m.id} type="button" onClick={() => toggleComboMesa(m.id)}
                          className={`rounded-lg border px-2.5 py-1.5 text-sm inline-flex items-baseline gap-1 transition-colors ${sel ? 'bg-brand-500 border-brand-500 text-white' : 'border-ink/15 text-ink hover:border-brand-300'}`}>
                    <span className="font-medium">{m.numero}</span>
                    {m.zona && <span className={`text-[11px] ${sel ? 'text-white/70' : 'text-ink-muted'}`}>{m.zona}</span>}
                  </button>
                );
              })}
            </div>
            {comboSel.length >= 2 && (
              <p className="text-xs text-ink-muted mb-3">
                {comboSel.map((id) => nombreDeMesa(id)).join(' + ')} · capacidad {capacidadDeGrupo(comboSel)} personas
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              {comboModo === 'grupo' && (
                <Field label="Máx. sillas vacías" className="w-36">
                  <input type="number" min={0} value={comboMaxVacias} onChange={(e) => setComboMaxVacias(e.target.value)}
                         placeholder="sin límite" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                </Field>
              )}
              {comboModo === 'fija' && (
                <>
                  <Field label="Desde" className="w-20">
                    <input type="number" min={1} value={comboMin} onChange={(e) => setComboMin(e.target.value)}
                           placeholder="1" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                  </Field>
                  <Field label="Hasta" className="w-20">
                    <input type="number" min={1} value={comboMax} onChange={(e) => setComboMax(e.target.value)}
                           placeholder={String(capacidadDeGrupo(comboSel) || '')} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                  </Field>
                </>
              )}
              <Field label="Nombre (opcional)" className="w-40">
                <input value={comboNombre} onChange={(e) => setComboNombre(e.target.value)}
                       placeholder={comboModo === 'grupo' ? 'ej. Barra' : 'ej. Sillones'} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </Field>
              <button onClick={() => void agregarCombo()} disabled={comboAgregando || comboSel.length < 2}
                      className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
                {comboAgregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {comboModo === 'grupo' ? 'Agregar grupo' : 'Agregar combinación'}
              </button>
            </div>
          </div>

          {/* Existentes */}
          {combos.length === 0 ? (
            <p className="text-sm text-ink-muted">Todavía no hay combinaciones. Armá una arriba (ej. un grupo con toda la barra).</p>
          ) : (
            <div className="divide-y divide-ink/5">
              {combos.map((c) => {
                const sum = capacidadDeGrupo(c.mesa_ids);
                const rango = c.tipo === 'grupo'
                  ? `hasta ${sum} pers.` + (c.max_sillas_vacias != null ? ` · máx. ${c.max_sillas_vacias} vacías` : '')
                  : `${c.min_personas ?? 1} a ${c.max_personas ?? sum} personas`;
                return (
                  <div key={c.id} className="flex items-center gap-3 py-2.5">
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${c.tipo === 'grupo' ? 'bg-brand-500/10 text-brand-600' : 'bg-ink/5 text-ink-soft'}`}>
                      {c.tipo === 'grupo' ? 'Grupo' : 'Fija'}
                    </span>
                    <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
                      {c.nombre && <span className="text-sm font-medium text-ink mr-1">{c.nombre}:</span>}
                      {c.mesa_ids.map((mid, i) => (
                        <span key={mid} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-ink-muted text-sm">+</span>}
                          <span className="rounded-md bg-ink/5 border border-ink/10 px-2 py-0.5 text-sm font-medium">{nombreDeMesa(mid)}</span>
                        </span>
                      ))}
                      <span className="text-ink-muted text-xs ml-1">· {rango}</span>
                    </div>
                    <Toggle checked={c.activa} onChange={(v) => void toggleComboActiva(c.id, v)} />
                    <button onClick={() => void eliminarCombo(c.id)} className="text-ink-muted hover:text-red-500 p-1 shrink-0" title="Eliminar"><Trash2 className="h-4 w-4" /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
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
