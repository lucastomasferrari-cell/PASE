// Formulario de alta/edición de reserva — compartido entre la lista de
// Reservas y el Diario (editar desde el timeline).

import { useState } from 'react';
import { toast } from 'sonner';
import { X, Users, Clock } from 'lucide-react';
import { crearReserva, editarReserva, type Reserva } from '@/lib/reservasService';

function aISO(fecha: string, horaStr: string) { return new Date(`${fecha}T${horaStr}`).toISOString(); }
function inputDate(f: Date) { return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`; }

export function ReservaForm({
  localId, localNombre, fechaDefault, reserva, onClose, onSaved,
}: {
  localId: number;
  localNombre: string;
  fechaDefault: Date;
  reserva: Reserva | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const esEdicion = reserva !== null;
  const fhInicial = reserva ? new Date(reserva.fecha_hora) : null;
  const [nombre, setNombre] = useState(reserva?.cliente_nombre ?? '');
  const [telefono, setTelefono] = useState(reserva?.cliente_telefono ?? '');
  const [personas, setPersonas] = useState(reserva?.personas ?? 2);
  const [fecha, setFecha] = useState(inputDate(fhInicial ?? fechaDefault));
  const [horaStr, setHoraStr] = useState(
    fhInicial ? `${String(fhInicial.getHours()).padStart(2, '0')}:${String(fhInicial.getMinutes()).padStart(2, '0')}` : '21:00',
  );
  const [notas, setNotas] = useState(reserva?.notas ?? '');
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    if (!nombre.trim()) { toast.error('Falta el nombre del cliente'); return; }
    if (personas < 1) { toast.error('Personas debe ser 1 o más'); return; }
    setGuardando(true);
    try {
      const fechaHora = aISO(fecha, horaStr);
      if (esEdicion && reserva) {
        const { error } = await editarReserva({
          reservaId: reserva.id, clienteNombre: nombre.trim(),
          clienteTelefono: telefono.trim() || undefined, fechaHora,
          personas, notas: notas.trim() || undefined,
        });
        if (error) { toast.error(error); return; }
        toast.success('Reserva actualizada');
      } else {
        const { error } = await crearReserva({
          localId, clienteNombre: nombre.trim(),
          clienteTelefono: telefono.trim() || undefined, fechaHora, personas,
          notas: notas.trim() || undefined,
          idempotencyKey: `mesa-admin-${localId}-${nombre.trim()}-${fechaHora}`,
        });
        if (error) { toast.error(error); return; }
        toast.success('Reserva creada');
      }
      onSaved();
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-medium">{esEdicion ? 'Editar reserva' : 'Nueva reserva'}</h3>
            <p className="text-xs text-ink-muted">{localNombre}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Nombre del cliente *</label>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Juan Pérez" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Teléfono</label>
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel"
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="+54 11 …" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Users className="h-3 w-3" />Personas</label>
            <input type="number" min={1} value={personas} onChange={(e) => setPersonas(Math.max(1, Number(e.target.value)))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Fecha</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft inline-flex items-center gap-1"><Clock className="h-3 w-3" />Hora</label>
            <input type="time" value={horaStr} onChange={(e) => setHoraStr(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Notas</label>
          <textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Cumpleaños, mesa junto a la ventana, alergias…" />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void guardar()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear reserva'}
          </button>
        </div>
      </div>
    </div>
  );
}
