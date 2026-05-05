import { Outlet } from 'react-router-dom';
import { useAuthPos } from '../lib/authPos';
import { PinPad } from '../pages/Pos/PinPad';

// Gate de rutas POS/Caja. Requiere empleado POS en sessionStorage. Si no hay,
// muestra PinPad. Si hay, renderiza Outlet.
export function PinGate() {
  const { empleado, loading } = useAuthPos();
  if (loading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-muted-foreground">
        Cargando…
      </div>
    );
  }
  if (!empleado) return <PinPad />;
  return <Outlet />;
}
