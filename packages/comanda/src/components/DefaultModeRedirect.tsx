import { Navigate } from 'react-router-dom';
import { useAuthPos } from '@/lib/authPos';
import { useFeaturesPosModos } from '@/lib/useFeaturesPosModos';
import type { PosModo, RolPos } from '@/types/database';

const DEFAULT_MODE_BY_ROL: Record<RolPos, PosModo> = {
  cajero:    'mostrador',
  encargado: 'salon',
  manager:   'salon',
  dueno:     'salon',
  // F1.3 (2026-05-15): bartender preparado en schema, default a mostrador
  // (barra de tragos). Mientras no tenga permisos seed activos, el PIN
  // queda bloqueado al login — esto es solo el fallback de modo default.
  bartender: 'mostrador',
};

// Componente que redirige a /pos/<modo-default> según el rol del empleado.
// IMPORTANTE: si no hay PIN ingresado, retorna null para que el PinGate
// (montado más afuera en App.tsx) muestre el PinPad. NO redirige a /login
// porque la sesión Supabase puede estar OK pero el PIN no.
export function DefaultModeRedirect() {
  const { empleado, loading } = useAuthPos();
  const enabledModos = useFeaturesPosModos();

  // Mientras carga el empleado, no redirigir todavía
  if (loading) return null;

  // Sin empleado: dejar que PinGate muestre el PinPad
  if (!empleado) return null;

  const preferred: PosModo = DEFAULT_MODE_BY_ROL[empleado.rol_pos] ?? 'salon';

  // Si el modo preferido NO está habilitado en este local, usar el primero
  // disponible. Si no hay ninguno (caso patológico), fallback a 'salon'.
  const target: PosModo = enabledModos.includes(preferred)
    ? preferred
    : enabledModos[0] ?? 'salon';

  return <Navigate to={`/pos/${target}`} replace />;
}
