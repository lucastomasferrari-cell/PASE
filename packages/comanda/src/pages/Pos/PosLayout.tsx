import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { db } from '../../lib/supabase';
import { getTurnoAbierto } from '../../services/turnosCajaService';
import type { TurnoCaja } from '../../types/database';
import { Badge } from '../../components/Badge';
import { relativoCorto } from '../../lib/format';

interface Props { children?: ReactNode }

// Header global de POS: empleado activo, turno, local, botones rápidos.
// Acepta children o Outlet.
export function PosLayout({ children }: Props) {
  const { user } = useAuth();
  const { empleado, logout: logoutPos } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (localId !== null) {
      getTurnoAbierto(localId).then((res) => setTurno(res.data));
    }
  }, [localId]);

  async function fullLogout() {
    logoutPos();
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  const esManager = empleado?.rol_pos === 'manager' || empleado?.rol_pos === 'dueno';

  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', fontFamily: 'system-ui' }}>
      <header style={header}>
        <Link to="/pos" style={{ fontWeight: 700, fontSize: 16, color: '#111827', textDecoration: 'none' }}>COMANDA</Link>
        <span style={{ fontSize: 12, color: '#9CA3AF' }}>·</span>
        <Link to="/caja" style={turnoLinkStyle(turno)}>
          {turno ? <>🟢 Turno #{turno.numero} · abierto {relativoCorto(turno.abierto_at)}</> : <>🔴 Sin turno abierto</>}
        </Link>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {empleado && (
            <span style={{ fontSize: 13 }}>
              <strong>{empleado.nombre}</strong>
              <Badge variant={rolColor(empleado.rol_pos)}>{empleado.rol_pos}</Badge>
            </span>
          )}
          <button type="button" onClick={logoutPos} style={btnSm} title="Cambiar empleado (volver al PinPad)">
            🔒
          </button>
          {esManager && (
            <Link to="/settings" style={{ ...btnSm, textDecoration: 'none', display: 'inline-block' }} title="Settings">⚙</Link>
          )}
          <button type="button" onClick={fullLogout} style={btnSm} title="Cerrar sesión Supabase">↩</button>
        </div>
      </header>
      <main>{children ?? <Outlet />}</main>
    </div>
  );
}

function rolColor(r: string): 'gray' | 'blue' | 'violet' | 'red' {
  if (r === 'cajero') return 'gray';
  if (r === 'encargado') return 'blue';
  if (r === 'manager') return 'violet';
  return 'red';
}

function turnoLinkStyle(turno: TurnoCaja | null): React.CSSProperties {
  return {
    fontSize: 12,
    color: turno ? '#065F46' : '#991B1B',
    textDecoration: 'none',
    fontWeight: 500,
  };
}

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 16px',
  borderBottom: '1px solid #E5E7EB',
  background: '#FFFFFF',
  position: 'sticky',
  top: 0,
  zIndex: 10,
};

const btnSm: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid #D1D5DB',
  borderRadius: 6,
  background: '#FFFFFF',
  cursor: 'pointer',
  fontSize: 13,
};
