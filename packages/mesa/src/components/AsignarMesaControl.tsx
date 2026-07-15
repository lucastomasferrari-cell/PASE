// Control de asignación de mesa(s) para una reserva, desde el panel admin.
// Dos caminos (feedback operación 15-jul — antes solo se podía UNA mesa):
//   ⚡ Auto  → el motor elige (y combina) la mejor mesa/tramo libre.
//   Mesas ▾ → selección MANUAL de una o varias (para forzar mesas puntuales).
// Ambos validan server-side (capacidad, ocupación, local). Reusable en la
// lista de Reservas y en el popover del Diario.

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Zap, ChevronDown, Check } from 'lucide-react';
import {
  autoAsignarMesaReserva, asignarMesasReserva,
  type Reserva, type MesaSimple,
} from '@/lib/reservasService';

export function AsignarMesaControl({
  reserva, mesas, onDone, size = 'sm',
}: {
  reserva: Reserva;
  mesas: MesaSimple[];
  onDone: () => void;
  size?: 'sm' | 'md';
}) {
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);

  // Pre-cargar la selección con lo que ya tiene asignado al abrir.
  useEffect(() => {
    if (abierto) {
      const actuales = reserva.mesas_ids?.length ? reserva.mesas_ids : (reserva.mesa_id ? [reserva.mesa_id] : []);
      setSel(new Set(actuales));
    }
  }, [abierto, reserva.mesas_ids, reserva.mesa_id]);

  // Cerrar el popover al clickear afuera.
  useEffect(() => {
    if (!abierto) return;
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setAbierto(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [abierto]);

  const porZona = useMemo(() => {
    const map = new Map<string, MesaSimple[]>();
    for (const m of mesas) {
      const z = m.zona ?? 'Sin zona';
      if (!map.has(z)) map.set(z, []);
      map.get(z)!.push(m);
    }
    return Array.from(map.entries());
  }, [mesas]);

  const capSel = useMemo(
    () => mesas.filter((m) => sel.has(m.id)).reduce((s, m) => s + (m.capacidad ?? 0), 0),
    [mesas, sel],
  );

  function toggle(id: number) {
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function auto() {
    setTrabajando(true);
    const { mesaIds, error } = await autoAsignarMesaReserva({ reservaId: reserva.id });
    setTrabajando(false);
    if (error) { toast.error(error); return; }
    const n = mesaIds?.length ?? 0;
    toast.success(n > 1 ? `Combinó ${n} mesas` : 'Mesa asignada');
    setAbierto(false);
    onDone();
  }

  async function asignarManual() {
    const ids = [...sel];
    if (ids.length === 0) { toast.error('Elegí al menos una mesa'); return; }
    setTrabajando(true);
    const { error } = await asignarMesasReserva({ reservaId: reserva.id, mesaIds: ids });
    setTrabajando(false);
    if (error) { toast.error(error); return; }
    toast.success(ids.length > 1 ? `Asignó ${ids.length} mesas` : 'Mesa asignada');
    setAbierto(false);
    onDone();
  }

  const btn = size === 'md' ? 'px-3 py-2 text-sm' : 'px-2 py-1.5 text-xs';

  return (
    <div className="relative inline-flex items-center gap-1.5" ref={boxRef}>
      <button
        onClick={() => void auto()}
        disabled={trabajando}
        title="Auto-asignar: el sistema elige (y combina) la mejor mesa libre"
        className={`inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-white hover:bg-brand-50 text-brand-700 font-medium disabled:opacity-50 ${btn}`}
      >
        <Zap className="h-3.5 w-3.5" /> Auto
      </button>
      <button
        onClick={() => setAbierto((v) => !v)}
        disabled={trabajando}
        title="Elegir mesa(s) a mano"
        className={`inline-flex items-center gap-1 rounded-lg border border-ink/15 bg-white hover:bg-ink/5 text-ink-soft font-medium disabled:opacity-50 ${btn}`}
      >
        Mesas <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {abierto && (
        <div className="absolute right-0 top-full mt-1 z-30 w-64 rounded-xl border border-ink/10 bg-white shadow-card p-2">
          <div className="max-h-64 overflow-y-auto pr-0.5">
            {porZona.map(([zona, ms]) => (
              <div key={zona} className="mb-1.5">
                <div className="text-[11px] font-medium text-ink-muted px-1.5 py-1">{zona}</div>
                {ms.map((m) => {
                  const on = sel.has(m.id);
                  return (
                    <button key={m.id} onClick={() => toggle(m.id)}
                      className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-left ${on ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink/5 text-ink'}`}>
                      <span className={`h-4 w-4 shrink-0 rounded border inline-flex items-center justify-center ${on ? 'bg-brand-500 border-brand-500 text-white' : 'border-ink/25'}`}>
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="flex-1">Mesa {m.numero}</span>
                      {m.capacidad != null && <span className="text-[11px] text-ink-muted">{m.capacidad}p</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2 mt-1 px-1">
            <span className="text-[11px] text-ink-muted">
              {sel.size === 0 ? 'Sin selección' : `${sel.size} mesa${sel.size > 1 ? 's' : ''} · ${capSel}p para ${reserva.personas}p`}
            </span>
            <button onClick={() => void asignarManual()} disabled={trabajando || sel.size === 0}
              className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              Asignar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
