// PIN del POS — empleados de COMANDA. Activar/desactivar el acceso al POS,
// asignar rol_pos (cajero/mozo/admin) y resetear PIN. Lee rrhh_empleados +
// fn_set_pin_pos. Usa el selector de local del shell.
//
// Look Command Center (17-jul): filas terminal listing, sin cajas
// envolviendo cada empleado. Chips outline mono para "SIN ROL", botones
// outline mono para "SETEAR PIN" / power. Ver mockup.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Power, KeyRound, X, Info } from 'lucide-react';
import { listEmpleadosPos, setPosActivo, setRolPos, setPin, type EmpleadoPos, type RolPos } from '@/lib/posService';
import { MiniNote } from '@/components/primitives';

interface Props { localId: number | null; locales: { id: number; nombre: string }[]; }

const ROLES_POS: RolPos[] = ['cajero', 'bartender', 'encargado', 'manager', 'dueno'];

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

  async function cambiarRol(e: EmpleadoPos, rol: RolPos | null) {
    setEmpleados((prev) => prev.map((x) => x.id === e.id ? { ...x, rol_pos: rol } : x));
    const { error } = await setRolPos(e.id, rol);
    if (error) { toast.error(error); void reload(); }
  }

  return (
    <div>
      <MiniNote tone="brand">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div>
          Cada uno entra con su{' '}
          <strong className="font-mono text-[11px] text-brand-300 tracking-widest2">PIN DE 4 DÍGITOS</strong>.
          El rol define qué puede hacer.
        </div>
      </MiniNote>

      {!localId && locales.length > 1 && (
        <MiniNote tone="warn">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>Elegí un local en la barra superior para ver sus empleados POS.</span>
        </MiniNote>
      )}

      {cargando ? (
        <div className="py-8 text-center text-dim-300 font-mono text-xs uppercase tracking-widest2">Cargando…</div>
      ) : empleados.length === 0 ? (
        <div className="border-t border-b border-carbon-600 py-12 text-center">
          <p className="font-medium text-dim-100">Sin empleados en este local</p>
          <p className="text-sm text-dim-300 mt-1">Cargá los empleados desde PASE → RRHH.</p>
        </div>
      ) : (
        <div>
          {empleados.map((e) => {
            const nombre = nombreEmpleado(e);
            const yaTienePin = !!e.pin_actualizado_at;
            return (
              <div
                key={e.id}
                className={`group py-4 flex items-center gap-4 flex-wrap transition-colors hover:bg-brand-400/[0.025] ${e.pos_activo ? '' : 'opacity-60'}`}
              >
                <div className="w-10 h-10 rounded-sm bg-carbon-700/60 text-brand-300 flex items-center justify-center font-mono text-sm shrink-0">
                  {(nombre[0] ?? '?').toUpperCase()}
                </div>
                <div className="flex-1 min-w-[180px]">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[15px] font-medium text-dim-50">{nombre}</span>
                    {!e.rol_pos && (
                      <span className="font-mono text-[10px] uppercase tracking-widest2 text-dim-400">
                        SIN ROL
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono uppercase tracking-widest2 text-dim-400 mt-1">
                    {e.puesto ?? '—'}
                    {yaTienePin && (
                      <> · PIN {new Date(e.pin_actualizado_at as string).toLocaleDateString('es-AR')}</>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
                  <select
                    value={e.rol_pos ?? ''}
                    onChange={(ev) => void cambiarRol(e, (ev.target.value || null) as RolPos | null)}
                    className="h-7 bg-transparent text-dim-100 font-mono text-[10px] uppercase tracking-widest2 px-1.5 capitalize border-0 focus:outline-none focus:text-dim-50 hover:text-dim-50 cursor-pointer"
                  >
                    <option value="" style={{background:'#0B1220'}}>Sin rol</option>
                    {ROLES_POS.map((r) => <option key={r} value={r} style={{background:'#0B1220'}}>{r}</option>)}
                  </select>
                  <button
                    onClick={() => setPinDe(e)}
                    className="text-brand-300 hover:text-brand-200 hover:bg-brand-400/10 font-mono uppercase tracking-widest2 px-2 h-7 text-[11px] inline-flex items-center gap-1.5 rounded-sm transition-colors"
                  >
                    <KeyRound className="h-3 w-3" /> {yaTienePin ? 'Cambiar PIN' : 'Setear PIN'}
                  </button>
                  <button
                    onClick={() => void toggle(e)}
                    title={e.pos_activo ? 'Desactivar' : 'Activar'}
                    className={`h-7 w-7 rounded-sm inline-flex items-center justify-center transition-colors ${
                      e.pos_activo
                        ? 'text-warn/70 hover:text-warn hover:bg-warn/10'
                        : 'text-live/70 hover:text-live hover:bg-live/10'
                    }`}
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
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
    <div className="fixed inset-0 z-50 bg-carbon-900/80 backdrop-blur flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-xs bg-carbon-800 border border-carbon-500 rounded-t-sm sm:rounded-sm shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-brand-400 tracking-widest2">SET //</span>
            <h3 className="text-lg font-semibold text-dim-50">PIN del POS</h3>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-sm hover:bg-carbon-700 text-dim-300 inline-flex items-center justify-center"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-dim-300">Pasale los 4 dígitos a {empleado.nombre}.</p>
        <input
          value={pin}
          onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric" autoFocus maxLength={4}
          className="w-full rounded-sm border border-carbon-500 bg-carbon-900 px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] text-dim-50 focus:outline-none focus:border-brand-400"
          placeholder="••••"
        />
        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-sm border border-carbon-500 bg-transparent text-dim-200 font-mono uppercase tracking-widest2 text-xs hover:bg-carbon-700"
          >
            Cancelar
          </button>
          <button
            onClick={() => void submit()}
            disabled={guardando || pin.length !== 4}
            className="flex-1 h-9 rounded-sm border border-brand-400/60 hover:border-brand-400 hover:bg-brand-400/10 text-brand-300 font-mono uppercase tracking-widest2 text-xs disabled:opacity-40"
          >
            {guardando ? 'Guardando…' : 'Guardar PIN'}
          </button>
        </div>
      </div>
    </div>
  );
}
