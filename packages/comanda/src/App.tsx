import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './lib/AuthProvider';
import { AuthPosProvider } from './lib/AuthPosProvider';
import { ProtectedShell } from './components/ProtectedShell';
import { RedirectIfAuth } from './components/RedirectIfAuth';
import { PinGate } from './components/PinGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './lib/auth';

import { LoginPage } from './pages/Login/LoginPage';
import { CatalogoLayout } from './pages/Catalogo/CatalogoLayout';
import { SettingsLayout } from './pages/Settings/SettingsLayout';

import { CajaAbrir } from './pages/Caja/CajaAbrir';
import { CajaEstado } from './pages/Caja/CajaEstado';
import { CajaCerrar } from './pages/Caja/CajaCerrar';
import { CajaHistorico } from './pages/Caja/CajaHistorico';

import { PosLayout } from './pages/Pos/PosLayout';
import { SalonView } from './pages/Pos/SalonView';
import { MostradorView } from './pages/Pos/MostradorView';
import { PedidosPlaceholder } from './pages/Pos/PedidosPlaceholder';
import { VentaScreen } from './pages/Pos/VentaScreen';
import { DefaultModeRedirect } from './components/DefaultModeRedirect';

// Rutas públicas (Sprint 4 sesión B)
import { TiendaLayout } from './pages/Tienda/TiendaLayout';
import { TiendaHome } from './pages/Tienda/TiendaHome';
import { TiendaCheckout } from './pages/Tienda/TiendaCheckout';
import { TiendaConfirmacion } from './pages/Tienda/TiendaConfirmacion';
import { TiendaSeguimiento } from './pages/Tienda/TiendaSeguimiento';
import { KdsView } from './pages/Kds/KdsView';
import { MenuQrView } from './pages/MenuQr/MenuQrView';

// Reportes (privadas, requieren auth)
import { ReportesLayout } from './pages/Reportes/ReportesLayout';
import { Dashboard as ReportesDashboard } from './pages/Reportes/Dashboard';
import { ReporteCanales } from './pages/Reportes/ReporteCanales';
import { ReporteProductos } from './pages/Reportes/ReporteProductos';
import { ReporteTiempos } from './pages/Reportes/ReporteTiempos';

// AuthGate: variante "headless" de ProtectedShell — verifica sesión Supabase
// pero NO renderiza header (lo provee PosLayout). Si no hay sesión, /login.
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground bg-background">
        Cargando…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthPosProvider>
          <Toaster
            position="top-center"
            richColors
            closeButton
            toastOptions={{
              classNames: {
                toast: 'font-sans',
              },
            }}
          />
          <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<RedirectIfAuth><LoginPage /></RedirectIfAuth>} />

            {/* Rutas PÚBLICAS (sin auth, sin PIN) */}
            <Route path="/tienda/:localSlug" element={<TiendaLayout />}>
              <Route index element={<TiendaHome />} />
              <Route path="checkout" element={<TiendaCheckout />} />
              <Route path="confirmacion/:ventaId" element={<TiendaConfirmacion />} />
              <Route path="seguimiento" element={<TiendaSeguimiento />} />
            </Route>
            <Route path="/kds/:estacion" element={<KdsView />} />
            <Route path="/menu/:token" element={<MenuQrView />} />

            {/* Rutas con header global de ProtectedShell (catálogo, settings, reportes) */}
            <Route element={<ProtectedShell />}>
              <Route path="/catalogo" element={<CatalogoLayout />} />
              <Route path="/settings" element={<SettingsLayout />} />
              <Route path="/reportes" element={<ReportesLayout />}>
                <Route index element={<ReportesDashboard />} />
                <Route path="canales" element={<ReporteCanales />} />
                <Route path="productos" element={<ReporteProductos />} />
                <Route path="tiempos" element={<ReporteTiempos />} />
              </Route>
            </Route>

            {/* Rutas POS / Caja: requieren sesión Supabase + PIN POS */}
            <Route element={<AuthGate />}>
              <Route element={<PinGate />}>
                <Route element={<PosLayout />}>
                  <Route path="/" element={<DefaultModeRedirect />} />
                  <Route path="/pos" element={<DefaultModeRedirect />} />
                  <Route path="/pos/salon" element={<SalonView />} />
                  <Route path="/pos/mostrador" element={<MostradorView />} />
                  <Route path="/pos/pedidos" element={<PedidosPlaceholder />} />
                  <Route path="/pos/venta/:ventaId" element={<VentaScreen />} />
                  <Route path="/caja" element={<CajaEstado />} />
                  <Route path="/caja/abrir" element={<CajaAbrir />} />
                  <Route path="/caja/cerrar" element={<CajaCerrar />} />
                  <Route path="/caja/historico" element={<CajaHistorico />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/pos" replace />} />
          </Routes>
          </ErrorBoundary>
        </AuthPosProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
