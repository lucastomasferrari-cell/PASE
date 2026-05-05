import { Outlet } from 'react-router-dom';
import { useAuthPos } from '../lib/authPos';
import { PinPad } from '../pages/Pos/PinPad';

// Gate de rutas POS/Caja. Requiere empleado POS en sessionStorage. Si no hay,
// muestra PinPad. Si hay, renderiza Outlet.
export function PinGate() {
  const { empleado, loading } = useAuthPos();
  if (loading) {
    return <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280' }}>Cargando…</div>;
  }
  if (!empleado) return <PinPad />;
  return <Outlet />;
}
