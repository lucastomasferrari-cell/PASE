import type { ReactNode } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { db } from '../lib/supabase';

interface Props {
  children?: ReactNode;
}

// Gate de rutas autenticadas. Si no hay sesión redirige a /login.
// Si hay sesión renderiza el header global (email + cerrar sesión)
// y el contenido debajo. Acepta children (Sprint 1) u Outlet (Sprint 2).
export function ProtectedShell({ children }: Props) {
  const { user, loading, error } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return <CenteredMsg>Cargando…</CenteredMsg>;
  }
  if (error) {
    return <CenteredMsg variant="error">Error de sesión: {error}</CenteredMsg>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  async function logout() {
    await db.auth.signOut();
    // El listener onAuthStateChange en useAuthInternal limpia el state.
    // Igual navegamos explícitamente para feedback inmediato.
    navigate('/login', { replace: true });
  }

  return (
    <>
      <header style={headerStyle}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>COMANDA</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {user.email && (
            <span style={{ fontSize: 13, color: '#6B7280' }} title={`${user.nombre} · ${user.rol}`}>
              {user.email}
            </span>
          )}
          <button type="button" onClick={logout} style={logoutBtn}>
            Cerrar sesión
          </button>
        </div>
      </header>
      {children ?? <Outlet />}
    </>
  );
}

function CenteredMsg({ children, variant }: { children: ReactNode; variant?: 'error' }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: variant === 'error' ? '#DC2626' : '#6B7280',
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 16px',
  borderBottom: '1px solid #E5E7EB',
  background: '#FFFFFF',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const logoutBtn: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid #D1D5DB',
  borderRadius: 6,
  background: '#FFFFFF',
  cursor: 'pointer',
  fontSize: 13,
  color: '#374151',
};
