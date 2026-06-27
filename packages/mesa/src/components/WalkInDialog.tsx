// Diálogo de walk-in / "de paso": sentar a un cliente sin reserva al instante.
// Compartido entre el Diario (botón "De paso") y el Mapa (click en mesa libre).

import { useState } from 'react';
import { toast } from 'sonner';
import { X, Users } from 'lucide-react';
import type { MesaSimple } from '@/lib/reservasService';

export function WalkInDialog({ mesas, mesaIdInicial, onClose, onSave }: {
  mesas: MesaSimple[];
  mesaIdInicial?: number;
  onClose: () => void;
  onSave: (input: { clienteNombre: string; personas: number; mesaId?: number }) => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState('Walk-in');
  const [personas, setPersonas] = useState(2);
  const [mesaId, setMesaId] = useState<number | ''>(mesaIdInicial ?? '');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!nombre.trim()) { toast.error('Poné un nombre o "Walk-in"'); return; }
    setGuardando(true);
    await onSave({ clienteNombre: nombre.trim(), personas, mesaId: mesaId === '' ? undefined : Number(mesaId) });
    setGuardando(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium">Sentar de paso</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-xs text-ink-muted -mt-2">Cliente que llegó sin reserva. Se crea ya sentado, con hora de ahora.</p>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Nombre</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)}
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Users className="h-3 w-3" />Personas</label>
            <input type="number" min={1} value={personas} onChange={(e) => setPersonas(Math.max(1, Number(e.target.value)))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Mesa</label>
            <select value={mesaId} onChange={(e) => setMesaId(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              <option value="">Sin mesa</option>
              {mesas.map((m) => <option key={m.id} value={m.id}>Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Sentando…' : 'Sentar'}
          </button>
        </div>
      </div>
    </div>
  );
}
