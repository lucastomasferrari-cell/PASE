// PIN del POS — empleados de COMANDA. Activar/desactivar el acceso al POS,
// asignar rol_pos (cajero/mozo/admin) y resetear PIN. Lee rrhh_empleados +
// fn_set_pin_pos. Usa el selector de local del shell.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Power, KeyRound, X } from 'lucide-react';
import { listEmpleadosPos, setPosActivo, setRolPos, setPin, type EmpleadoPos } from '@/lib/posService';

interface Props { localId: number | null; locales: { id: number; nombre: string }[]; }

const ROLES_POS: ('cajero' | 'mozo' | 'admin')[] = ['cajero', 'mozo', 'admin'];

function nombreEmpleado(e: EmpleadoPos) {
  return [e.nombre, e.apellido].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

export function PinPos({ localId, locales }: Props) {
  const [empleados, setEmpleados] = useState<EmpleadoPos[]>([]);
  const [cargando, setCargando] = useState(true);
  const [pinDe, setPinDe] = useState<EmpleadoPos | null>(null);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listEmpleadosPos(localId);
    if (error) toast.error(error);
    setEmpleados(data);
    setCargando(false);
  }, [localId]);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(e: EmpleadoPos) {
    setEmpleados((prev) => prev.map((x) => x.id === e.id ? { ...x, pos_activo: !x.pos_activo } : x));
    const { error } = await setPosActivo(e.id, !e.pos_activo);
    if (error) { toast.error(error); void reload(); }
  }

  async function cambiarRol(e: EmpleadoPos, rol: 'cajero' | 'mozo' | 'admin' | null) {
    setEmpleados((prev) => prev.map((x) => x.id === e.id ? { ...x, rol_pos: rol } : x));
    const { error } = await setRolPos(e.id, rol);
    if (error) { toast.error(error); void reload(); }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-ink-muted">Empleados que pueden entrar al POS de COMANDA. Cada uno tiene su <strong>PIN de 4 dígitos</strong> y un rol que define qué puede hacer (cobrar, sentar, anular, etc).</p>

      {!localId && locales.length > 1 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">
          Elegí un local en la barra superior para ver sus empleados POS.
        </div>
      )}

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : empleados.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
          <p className="font-medium">Sin empleados en este local</p>
          <p className="text-sm text-ink-muted mt-1">Cargá los empleados desde PASE → RRHH.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {empleados.map((e) => (
            <div key={e.id} className={`rounded-2xl bg-white border shadow-card p-4 flex items-center gap-3 flex-wrap ${e.pos_activo ? 'border-ink/5' : 'border-ink/5 opacity-60'}`}>
              <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
                {(nombreEmpleado(e)[0] ?? '?').toUpperCase()}
              </div>
              <div className="flex-1 min-w-[160px]">
                <div className="font-medium">{nombreEmpleado(e)}</div>
                {e.puesto && <div className="text-xs text-ink-muted">{e.puesto}</div>}
                {e.pin_actualizado_at && <div className="text-[11px] text-ink-muted mt-0.5">PIN seteado el {new Date(e.pin_actualizado_at).toLocaleDateString('es-AR')}</div>}
              </div>
              <div className="flex items-center gap-1.5">
                <select value={e.rol_pos ?? ''} onChange={(ev) => void cambiarRol(e, (ev.target.value || null) as 'cajero' | 'mozo' | 'admin' | null)}
                        className="text-xs rounded-lg border border-ink/15 bg-white px-2 py-1.5">
                  <option value="">Sin rol</option>
                  {ROLES_POS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button onClick={() => setPinDe(e)} className="text-xs px-2.5 py-1.5 rounded-lg border border-brand-200 bg-white hover:bg-brand-50 text-brand-700 font-medium inline-flex items-center gap-1">
                  <KeyRound className="h-3.5 w-3.5" /> {e.pin_actualizado_at ? 'Cambiar' : 'Setear'} PIN
                </button>
                <button onClick={() => void toggle(e)} title={e.pos_activo ? 'Desactivar' : 'Activar'}
                        className={`p-2 rounded-lg border ${e.pos_activo ? 'border-amber-200 text-amber-700 hover:bg-amber-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}>
                  <Power className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pinDe && (
        <PinDialog empleado={pinDe} onClose={() => setPinDe(null)}
                   onSaved={() => { setPinDe(null); void reload(); }} />
      )}
    </div>
  );
}

function PinDialog({ empleado, onClose, onSaved }: { empleado: EmpleadoPos; onClose: () => void; onSaved: () => void }) {
  const [pin, setPinValue] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) { toast.error('El PIN debe ser exactamente 4 dígitos'); return; }
    setGuardando(true);
    const { error } = await setPin(empleado.id, pin);
    setGuardando(false);
    if (error) { toast.error(error); return; }
    toast.success('PIN actualizado');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-xs bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl font-semibold">PIN del POS</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-xs text-ink-muted -mt-2">Pasale los 4 dígitos a {empleado.nombre}.</p>
        <input value={pin} onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
               inputMode="numeric" autoFocus maxLength={4}
               className="w-full rounded-lg border border-ink/15 px-3 py-3 text-center font-mono text-2xl tracking-[0.4em]" placeholder="••••" />
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando || pin.length !== 4}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Guardar PIN'}
          </button>
        </div>
      </div>
    </div>
  );
}
