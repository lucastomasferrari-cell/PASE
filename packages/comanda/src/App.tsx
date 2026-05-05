import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/AuthProvider';
import { AuthPosProvider } from './lib/AuthPosProvider';
import { ProtectedShell } from './components/ProtectedShell';
import { RedirectIfAuth } from './components/RedirectIfAuth';
import { PinGate } from './components/PinGate';

import { LoginPage } from './pages/Login/LoginPage';
import { CatalogoLayout } from './pages/Catalogo/CatalogoLayout';
import { SettingsLayout } from './pages/Settings/SettingsLayout';

import { CajaAbrir } from './pages/Caja/CajaAbrir';
import { CajaEstado } from './pages/Caja/CajaEstado';
import { CajaCerrar } from './pages/Caja/CajaCerrar';

import { PosLayout } from './pages/Pos/PosLayout';
import { PosSelectorModo } from './pages/Pos/PosSelectorModo';
import { SalonView } from './pages/Pos/SalonView';
import { MostradorView } from './pages/Pos/MostradorView';
import { PedidosPlaceholder } from './pages/Pos/PedidosPlaceholder';
import { VentaScreen } from './pages/Pos/VentaScreen';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthPosProvider>
          <Routes>
            <Route path="/login" element={<RedirectIfAuth><LoginPage /></RedirectIfAuth>} />

            {/* Rutas con header global Sprint 1 (catalogo, settings) */}
            <Route element={<ProtectedShell />}>
              <Route path="/catalogo" element={<CatalogoLayout />} />
              <Route path="/settings" element={<SettingsLayout />} />
            </Route>

            {/* Rutas POS / Caja: requieren sesión Supabase + PIN POS */}
            <Route element={<AuthGate />}>
              <Route element={<PinGate />}>
                <Route element={<PosLayout />}>
                  <Route path="/" element={<PosSelectorModo />} />
                  <Route path="/pos" element={<PosSelectorModo />} />
                  <Route path="/pos/salon" element={<SalonView />} />
                  <Route path="/pos/mostrador" element={<MostradorView />} />
                  <Route path="/pos/pedidos" element={<PedidosPlaceholder />} />
                  <Route path="/pos/venta/:ventaId" element={<VentaScreen />} />
                  <Route path="/caja" element={<CajaEstado />} />
                  <Route path="/caja/abrir" element={<CajaAbrir />} />
                  <Route path="/caja/cerrar" element={<CajaCerrar />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/pos" replace />} />
          </Routes>
        </AuthPosProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}

// AuthGate: variante "headless" de ProtectedShell — verifica sesión Supabase
// pero NO renderiza header (lo provee PosLayout). Si no hay sesión, /login.
import { Navigate as Nav, Outlet } from 'react-router-dom';
import { useAuth } from './lib/auth';
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontFamily: 'system-ui' }}>
        Cargando…
      </div>
    );
  }
  if (!user) return <Nav to="/login" replace />;
  return <Outlet />;
}
