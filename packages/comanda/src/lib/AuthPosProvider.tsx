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
import { getLocalSettings } from '../services/localSettingsService';

// Default cambiado de 3 → 60 min (29-may, queja Lucas): los cajeros de
// restaurant se quejaban de tener que re-poner PIN cada vez que iban a
// atender una mesa. 60 min cubre un turno completo de servicio sin
// fricciones. Si el dueño quiere más estricto, lo baja en
// Settings → Local → "Auto-lock POS (min)". Si quiere DESACTIVAR, pone 0.
const DEFAULT_AUTOLOCK_MIN = 60;

interface Props {
  children: ReactNode;
  // Override del autolock. Si no se pasa, intenta leer
  // `comanda_local_settings.autolock_minutos` del local activo después del
  // loginPin. Si no se puede leer, usa DEFAULT_AUTOLOCK_MIN.
  // Pasar 0 = desactivar auto-lock (cajero queda logueado hasta que cierre
  // pestaña o se desloguee manualmente).
  autolockMin?: number;
}

export function AuthPosProvider({ children, autolockMin }: Props) {
  const [empleado, setEmpleado] = useState<EmpleadoActivoPos | null>(null);
  const [loading, setLoading] = useState(true);
  // Auto-lock dinámico: lo leemos del setting del local DESPUÉS del login
  // (cuando ya sabemos qué local es). Se actualiza si Settings cambia.
  const [lockMinDinamico, setLockMinDinamico] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prioridad: prop explícito > setting del local > default
  const lockMinutes = autolockMin ?? lockMinDinamico ?? DEFAULT_AUTOLOCK_MIN;

  // Hidratar de sessionStorage al montar
  useEffect(() => {
    const fromSs = readEmpleadoFromStorage();
    if (fromSs) setEmpleado(fromSs);
    setLoading(false);
  }, []);

  // Cargar setting de auto-lock del local activo (después del login).
  // Si el setting es null o 0, deshabilita auto-lock (lockMinutes = 0).
  useEffect(() => {
    if (!empleado) { setLockMinDinamico(null); return; }
    let cancelled = false;
    void getLocalSettings(empleado.local_id).then(({ data }) => {
      if (cancelled) return;
      if (data && typeof data.autolock_minutos === 'number') {
        setLockMinDinamico(data.autolock_minutos);
      }
    });
    return () => { cancelled = true; };
  }, [empleado]);

  // Auto-lock timer. Si lockMinutes <= 0, no arma timer (auto-lock OFF).
  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!empleado) return;
    if (lockMinutes <= 0) return; // 0 = sin auto-lock
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

  // Fix 28-jun: cuando el dueño/admin cambia de local desde el sidebar
  // (writeLocalActivo dispara 'comanda:local-activo-changed'), si el
  // empleado POS activo pertenece a otro local, lo deslogueamos. Sin esto,
  // al abrir caja o cobrar tira "EMPLEADO_NO_EN_LOCAL" porque el RPC
  // valida que el cajero pertenezca al local. Forzar nuevo PIN para el
  // local nuevo es el comportamiento correcto (el cajero del local A no
  // debería poder operar en el local B sin re-identificarse).
  useEffect(() => {
    if (!empleado) return;
    const handler = (e: Event) => {
      const newLocalId = (e as CustomEvent<number | null>).detail;
      if (typeof newLocalId === 'number' && newLocalId !== empleado.local_id) {
        console.info('[authPos] local cambió, deslogueando POS', { from: empleado.local_id, to: newLocalId });
        writeEmpleadoToStorage(null);
        setEmpleado(null);
      }
    };
    window.addEventListener('comanda:local-activo-changed', handler);
    return () => window.removeEventListener('comanda:local-activo-changed', handler);
  }, [empleado]);

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
      pos_favoritos: emp.pos_favoritos ?? [],
    };
    writeEmpleadoToStorage(activo);
    setEmpleado(activo);
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    writeEmpleadoToStorage(null);
    setEmpleado(null);
    // AUDIT F5B#2: limpiar IndexedDB en logout para evitar corrupción
    // cross-tenant. Antes las ops del user A se sincronizaban con el JWT
    // del user B al loguearse otra cuenta.
    // Lazy import para no traer la dep al bundle inicial.
    void import('./db').then(({ resetDb }) => {
      void resetDb().catch((e: unknown) => {
        console.warn('[logout] resetDb falló (no crítico):', e);
      });
    });
  }, []);

  const resetTimer = useCallback(() => { armTimer(); }, [armTimer]);

  const toggleFavorito = useCallback(async (itemId: number) => {
    if (!empleado) return { ok: false, error: 'Sin empleado activo' };
    const { toggleFavoritoPos } = await import('@/services/empleadosService');
    const { favoritos, error } = await toggleFavoritoPos(empleado.id, itemId);
    if (error) return { ok: false, error };
    const nuevoEmpleado: EmpleadoActivoPos = { ...empleado, pos_favoritos: favoritos ?? [] };
    writeEmpleadoToStorage(nuevoEmpleado);
    setEmpleado(nuevoEmpleado);
    return { ok: true };
  }, [empleado]);

  const value: AuthPosContextValue = {
    empleado,
    loading,
    loginPin,
    logout,
    resetTimer,
    toggleFavorito,
  };

  return <AuthPosContext.Provider value={value}>{children}</AuthPosContext.Provider>;
}
