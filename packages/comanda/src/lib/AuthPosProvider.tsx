import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AuthPosContext,
  type AuthPosContextValue,
  type EmpleadoActivoPos,
  readEmpleadoFromStorage,
  writeEmpleadoToStorage,
} from './authPos';
import { verificarPin, getEmpleado } from '../services/empleadosService';

const DEFAULT_AUTOLOCK_MIN = 3;

interface Props {
  children: ReactNode;
  // Override del autolock (default 3 min). Settings del local lo configura.
  autolockMin?: number;
}

export function AuthPosProvider({ children, autolockMin }: Props) {
  const [empleado, setEmpleado] = useState<EmpleadoActivoPos | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lockMinutes = autolockMin ?? DEFAULT_AUTOLOCK_MIN;

  // Hidratar de sessionStorage al montar
  useEffect(() => {
    const fromSs = readEmpleadoFromStorage();
    if (fromSs) setEmpleado(fromSs);
    setLoading(false);
  }, []);

  // Auto-lock timer
  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!empleado) return;
    timerRef.current = setTimeout(() => {
      writeEmpleadoToStorage(null);
      setEmpleado(null);
    }, lockMinutes * 60_000);
  }, [empleado, lockMinutes]);

  useEffect(() => {
    armTimer();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [armTimer]);

  // Refresca timer en cada interacción global del documento
  useEffect(() => {
    if (!empleado) return;
    const onActivity = () => armTimer();
    const events: Array<keyof DocumentEventMap> = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    for (const e of events) document.addEventListener(e, onActivity, { passive: true });
    return () => {
      for (const e of events) document.removeEventListener(e, onActivity);
    };
  }, [empleado, armTimer]);

  const loginPin = useCallback(async (localId: number, pin: string) => {
    const { empleadoId, error } = await verificarPin(localId, pin);
    if (error) return { ok: false, error };
    if (!empleadoId) return { ok: false, error: 'PIN incorrecto' };
    const { data: emp, error: empErr } = await getEmpleado(empleadoId);
    if (empErr || !emp) return { ok: false, error: empErr ?? 'No se pudo cargar empleado' };
    if (!emp.rol_pos) return { ok: false, error: 'Empleado sin rol POS asignado' };
    const activo: EmpleadoActivoPos = {
      id: emp.id,
      nombre: `${emp.apellido} ${emp.nombre}`.trim(),
      rol_pos: emp.rol_pos,
      local_id: localId,
      desde: new Date().toISOString(),
    };
    writeEmpleadoToStorage(activo);
    setEmpleado(activo);
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    writeEmpleadoToStorage(null);
    setEmpleado(null);
  }, []);

  const resetTimer = useCallback(() => { armTimer(); }, [armTimer]);

  const value: AuthPosContextValue = {
    empleado,
    loading,
    loginPin,
    logout,
    resetTimer,
  };

  return <AuthPosContext.Provider value={value}>{children}</AuthPosContext.Provider>;
}
