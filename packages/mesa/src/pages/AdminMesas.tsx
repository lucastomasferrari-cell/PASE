// Editor de mesas / plano del salón — sección del admin de MESA.
// Permite cargar el salón real (número, zona/sector, capacidad, reservable),
// que alimenta el motor de reservas (asignación por mesa + selector de sector).
// Escribe directo en `mesas` (RLS: dueño/admin con permiso comanda.mesas.gestionar).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, LayoutGrid } from 'lucide-react';
import { db } from '@/lib/supabase';

interface Mesa { id: number; numero: string; zona: string | null; capacidad: number | null; reservable: boolean }

export function AdminMesas({ localId, tenantId }: { localId: number; tenantId: string }) {
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [cargando, setCargando] = useState(true);
  const [nueva, setNueva] = useState({ numero: '', zona: '', capacidad: '4' });
  const [agregando, setAgregando] = useState(false);

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

  const zonasExistentes = Array.from(new Set(mesas.map((m) => m.zona).filter(Boolean))) as string[];

  async function agregar() {
    if (!nueva.numero.trim()) { toast.error('Poné un número/nombre de mesa'); return; }
    setAgregando(true);
    try {
      const { data, error } = await db().from('mesas').insert({
        tenant_id: tenantId, local_id: localId,
        numero: nueva.numero.trim(),
        zona: nueva.zona.trim() || null,
        capacidad: nueva.capacidad ? Number(nueva.capacidad) : null,
        forma: 'cuadrado', reservable: true,
      }).select('id, numero, zona, capacidad, reservable').single();
      if (error) { toast.error('No se pudo agregar: ' + error.message); return; }
      setMesas((prev) => [...prev, data as Mesa]);
      setNueva((n) => ({ ...n, numero: '' }));
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

  if (cargando) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-ink-muted" /></div>;

  const totalCubiertos = mesas.filter((m) => m.reservable).reduce((s, m) => s + (m.capacidad ?? 0), 0);

  return (
    <div className="mt-6 max-w-3xl space-y-5 pb-10">
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <p className="font-medium flex items-center gap-2"><LayoutGrid className="h-4 w-4 text-brand-500" /> Cargar mesa</p>
        <p className="text-xs text-ink-muted mt-1 mb-3">El sector (zona) es lo que el cliente elige al reservar. Ej: Barra, Salón, Terraza, Privado.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Número / nombre" className="w-28">
            <input value={nueva.numero} onChange={(e) => setNueva((n) => ({ ...n, numero: e.target.value }))}
                   placeholder="ej. 12" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Field>
          <Field label="Sector / zona" className="w-40">
            <input value={nueva.zona} list="zonas-existentes" onChange={(e) => setNueva((n) => ({ ...n, zona: e.target.value }))}
                   placeholder="ej. Salón" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            <datalist id="zonas-existentes">{zonasExistentes.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
          <Field label="Capacidad" className="w-24">
            <input type="number" min={1} value={nueva.capacidad} onChange={(e) => setNueva((n) => ({ ...n, capacidad: e.target.value }))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Field>
          <button onClick={() => void agregar()} disabled={agregando}
                  className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
            {agregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Agregar
          </button>
        </div>
      </div>

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
                <input defaultValue={m.zona ?? ''} list="zonas-existentes" onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== m.zona) void patch(m.id, { zona: v }); }}
                       className="rounded-lg border border-ink/10 px-2 py-1.5 text-sm" />
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
