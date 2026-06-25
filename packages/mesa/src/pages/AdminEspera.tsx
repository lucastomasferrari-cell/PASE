// Lista de espera (walk-ins) — sección del panel admin de MESA (etapa 4).
// Clientes que llegan sin reserva con el local lleno: se anotan, se "llaman"
// cuando se libera mesa, y se sientan.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Users, Clock, BellRing, Armchair, X } from 'lucide-react';
import {
  listWaitlistActiva, agregarWaitlist, llamarWaitlist, sentarWaitlist, cancelarWaitlist,
  type WaitlistEntry,
} from '@/lib/waitlistService';

interface Props { localId: number; tenantId: string; }

function esperaMin(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export function AdminEspera({ localId, tenantId }: Props) {
  const [lista, setLista] = useState<WaitlistEntry[]>([]);
  const [cargando, setCargando] = useState(true);
  const [agregando, setAgregando] = useState(false);

  const reload = useCallback(async () => {
    const { data, error } = await listWaitlistActiva(localId);
    if (error) toast.error('No se pudo cargar la lista de espera: ' + error);
    setLista(data);
    setCargando(false);
  }, [localId]);

  useEffect(() => { setCargando(true); void reload(); }, [reload]);
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 60000);
    return () => clearInterval(id);
  }, [reload]);

  async function accion(p: Promise<{ error: string | null }>, okMsg: string) {
    const { error } = await p;
    if (error) { toast.error(error); return; }
    toast.success(okMsg);
    void reload();
  }

  return (
    <div className="mt-6 space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {lista.length === 0 ? 'Nadie esperando' : `${lista.length} grupo${lista.length !== 1 ? 's' : ''} en espera`}
        </p>
        <button onClick={() => setAgregando(true)}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Anotar
        </button>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : lista.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
          <p className="font-medium">Lista de espera vacía</p>
          <p className="text-sm text-ink-muted mt-1">Anotá a los que llegan sin reserva cuando no hay mesa.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lista.map((w, i) => (
            <div key={w.id} className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 flex items-center gap-3 flex-wrap">
              <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-semibold text-sm shrink-0">{i + 1}</div>
              <div className="flex-1 min-w-[140px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{w.cliente_nombre}</span>
                  <span className="text-[11px] inline-flex items-center gap-0.5 text-ink-muted"><Users className="h-3 w-3" />{w.personas}</span>
                  {w.estado === 'llamado' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Llamado</span>
                  )}
                </div>
                <div className="text-xs text-ink-muted flex items-center gap-2 mt-0.5">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{esperaMin(w.created_at)} min</span>
                  {w.cliente_telefono && <span>· {w.cliente_telefono}</span>}
                </div>
                {w.notas && <div className="text-xs text-ink-soft italic mt-0.5">{w.notas}</div>}
              </div>
              <div className="flex items-center gap-1.5">
                {w.estado === 'esperando' && (
                  <button onClick={() => void accion(llamarWaitlist(w.id), 'Cliente llamado')}
                          className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-amber-700 font-medium inline-flex items-center gap-1">
                    <BellRing className="h-3.5 w-3.5" /> Llamar
                  </button>
                )}
                <button onClick={() => void accion(sentarWaitlist(w.id), 'Cliente sentado')}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-medium inline-flex items-center gap-1">
                  <Armchair className="h-3.5 w-3.5" /> Sentar
                </button>
                <button onClick={() => void accion(cancelarWaitlist(w.id), 'Sacado de la lista')}
                        className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft" title="Quitar"><X className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {agregando && (
        <FormEspera
          onClose={() => setAgregando(false)}
          onSave={async (input) => {
            const { error } = await agregarWaitlist(tenantId, localId, input);
            if (error) { toast.error(error); return; }
            toast.success('Anotado en la lista');
            setAgregando(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function FormEspera({ onClose, onSave }: {
  onClose: () => void;
  onSave: (input: { clienteNombre: string; clienteTelefono?: string; personas: number; notas?: string }) => void;
}) {
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [personas, setPersonas] = useState(2);
  const [notas, setNotas] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!nombre.trim()) { toast.error('Falta el nombre'); return; }
    setGuardando(true);
    await onSave({ clienteNombre: nombre.trim(), clienteTelefono: telefono.trim() || undefined, personas, notas: notas.trim() || undefined });
    setGuardando(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl font-semibold">Anotar en espera</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Nombre *</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Juan" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Teléfono</label>
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Users className="h-3 w-3" />Personas</label>
            <input type="number" min={1} value={personas} onChange={(e) => setPersonas(Math.max(1, Number(e.target.value)))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Notas</label>
          <input value={notas} onChange={(e) => setNotas(e.target.value)}
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Prefiere ventana…" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Anotar'}
          </button>
        </div>
      </div>
    </div>
  );
}
