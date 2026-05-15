import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './lib/AuthProvider';
import { AuthPosProvider } from './lib/AuthPosProvider';
import { RedirectIfAuth } from './components/RedirectIfAuth';
import { PinGate } from './components/PinGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './lib/auth';

import { LoginPage } from './pages/Login/LoginPage';

import { CajaAbrir } from './pages/Caja/CajaAbrir';
import { CajaEstado } from './pages/Caja/CajaEstado';
import { CajaCerrar } from './pages/Caja/CajaCerrar';
import { CajaHistorico } from './pages/Caja/CajaHistorico';

import { PosLayout } from './pages/Pos/PosLayout';
import { SalonView } from './pages/Pos/SalonView';
import { MostradorView } from './pages/Pos/MostradorView';
import { PedidosHub } from './pages/Pos/PedidosHub';
import { PedidoDetalle } from './pages/Pos/PedidoDetalle';
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

// Admin Layout (sprint 6)
import { AdminLayout } from './components/admin/AdminLayout';
import { StubRoute } from './pages/admin-stubs/StubRoute';
import {
  ItemsRoute, GruposRoute, CanalesRoute, ListaPreciosRoute,
  ModificadoresRoute, EmpleadosListaRoute,
} from './pages/admin-stubs/routeWrappers';

// Páginas admin existentes que se montan dentro de AdminLayout
import { ReportesLayout } from './pages/Reportes/ReportesLayout';
import { Dashboard as ReportesDashboard } from './pages/Reportes/Dashboard';
import { ReporteCanales } from './pages/Reportes/ReporteCanales';
import { ReporteProductos } from './pages/Reportes/ReporteProductos';
import { ReporteTiempos } from './pages/Reportes/ReporteTiempos';

import { SettingsLocal } from './pages/Settings/SettingsLocal';
import { SettingsMesas } from './pages/Settings/SettingsMesas';
import { SettingsMetodosCobro } from './pages/Settings/SettingsMetodosCobro';
import { SettingsPermisos } from './pages/Settings/SettingsPermisos';
import { SettingsAuditoria } from './pages/Settings/SettingsAuditoria';
import { SettingsKds } from './pages/Settings/SettingsKds';
import { SettingsMenuQr } from './pages/Settings/SettingsMenuQr';
import { SettingsEstaciones } from './pages/Settings/SettingsEstaciones';

// AuthGate: variante "headless" — verifica sesión Supabase pero NO
// renderiza header (lo provee PosLayout). Si no hay sesión, /login.
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

// Mapping de rutas viejas a nuevas (sprint 6). Mantenemos redirects para
// no romper bookmarks ni links externos.
const REDIRECTS: Array<[string, string]> = [
  // Catálogo viejo → Menú nuevo
  ['/catalogo', '/menu/items'],
  ['/catalogo/items', '/menu/items'],
  ['/catalogo/grupos', '/menu/grupos'],
  ['/catalogo/canales', '/menu/canales'],
  ['/catalogo/lista-precios', '/menu/lista-precios'],
  ['/catalogo/modificadores', '/menu/modificadores'],
  // Settings viejo → categorías nuevas distribuidas
  ['/settings', '/configuracion/local'],
  ['/settings/general', '/configuracion/local'],
  ['/settings/empleados', '/empleados/lista'],
  ['/settings/mesas', '/salon/mesas'],
  ['/settings/metodos-cobro', '/pagos/metodos'],
  ['/settings/permisos', '/empleados/permisos'],
  ['/settings/auditoria', '/reportes/auditoria'],
  ['/settings/kds', '/online/kds'],
  ['/settings/menu-qr', '/online/menu-qr'],
  ['/settings/estaciones', '/hardware/estaciones'],
];

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

            {/* Redirects de rutas viejas a nuevas (sprint 6) */}
            {REDIRECTS.map(([from, to]) => (
              <Route key={from} path={from} element={<Navigate to={to} replace />} />
            ))}

            {/* Admin con sidebar permanente (sprint 6) */}
            <Route element={<AdminLayout />}>
              {/* ── Reportes ──────────────────────────────────────── */}
              <Route path="/reportes" element={<Navigate to="/reportes/dashboard" replace />} />
              <Route path="/reportes" element={<ReportesLayout />}>
                <Route path="dashboard" element={<ReportesDashboard />} />
                <Route path="canales" element={<ReporteCanales />} />
                <Route path="productos" element={<ReporteProductos />} />
                <Route path="tiempos" element={<ReporteTiempos />} />
              </Route>
              <Route path="/reportes/auditoria" element={<SettingsAuditoria />} />
              <Route path="/reportes/ventas" element={<StubRoute />} />
              <Route path="/reportes/empleados" element={<StubRoute />} />

              {/* ── Menú (catálogo) ───────────────────────────────── */}
              <Route path="/menu" element={<Navigate to="/menu/items" replace />} />
              <Route path="/menu/items" element={<ItemsRoute />} />
              <Route path="/menu/grupos" element={<GruposRoute />} />
              <Route path="/menu/canales" element={<CanalesRoute />} />
              <Route path="/menu/lista-precios" element={<ListaPreciosRoute />} />
              <Route path="/menu/modificadores" element={<ModificadoresRoute />} />
              <Route path="/menu/combos" element={<StubRoute />} />
              <Route path="/menu/disponibilidad" element={<StubRoute />} />

              {/* ── Salón ─────────────────────────────────────────── */}
              <Route path="/salon" element={<Navigate to="/salon/mesas" replace />} />
              <Route path="/salon/mesas" element={<SettingsMesas />} />
              <Route path="/salon/servicios" element={<StubRoute />} />
              <Route path="/salon/reservas" element={<StubRoute />} />

              {/* ── Empleados ─────────────────────────────────────── */}
              <Route path="/empleados" element={<Navigate to="/empleados/lista" replace />} />
              <Route path="/empleados/lista" element={<EmpleadosListaRoute />} />
              <Route path="/empleados/permisos" element={<SettingsPermisos />} />
              <Route path="/empleados/horarios" element={<StubRoute />} />
              <Route path="/empleados/performance" element={<StubRoute />} />

              {/* ── Pagos y caja ──────────────────────────────────── */}
              <Route path="/pagos" element={<Navigate to="/pagos/metodos" replace />} />
              <Route path="/pagos/metodos" element={<SettingsMetodosCobro />} />
              <Route path="/pagos/caja-chica" element={<StubRoute />} />
              <Route path="/pagos/historico-turnos" element={<StubRoute />} />
              <Route path="/pagos/conciliacion-mp" element={<StubRoute />} />
              <Route path="/pagos/settlements" element={<StubRoute />} />

              {/* ── Online ────────────────────────────────────────── */}
              <Route path="/online" element={<Navigate to="/online/menu-qr" replace />} />
              <Route path="/online/menu-qr" element={<SettingsMenuQr />} />
              <Route path="/online/kds" element={<SettingsKds />} />
              <Route path="/online/tienda" element={<StubRoute />} />
              <Route path="/online/tracking" element={<StubRoute />} />

              {/* ── Hardware ──────────────────────────────────────── */}
              <Route path="/hardware" element={<Navigate to="/hardware/estaciones" replace />} />
              <Route path="/hardware/estaciones" element={<SettingsEstaciones />} />
              <Route path="/hardware/impresoras" element={<StubRoute />} />
              <Route path="/hardware/cajon" element={<StubRoute />} />
              <Route path="/hardware/mp-point" element={<StubRoute />} />
              <Route path="/hardware/tablets-kds" element={<StubRoute />} />

              {/* ── Marketing (todos stubs) ───────────────────────── */}
              <Route path="/marketing" element={<Navigate to="/marketing/promociones" replace />} />
              <Route path="/marketing/promociones" element={<StubRoute />} />
              <Route path="/marketing/cupones" element={<StubRoute />} />
              <Route path="/marketing/fidelidad" element={<StubRoute />} />
              <Route path="/marketing/campanas" element={<StubRoute />} />

              {/* ── Clientes (todos stubs) ────────────────────────── */}
              <Route path="/clientes" element={<Navigate to="/clientes/lista" replace />} />
              <Route path="/clientes/lista" element={<StubRoute />} />
              <Route path="/clientes/historial" element={<StubRoute />} />
              <Route path="/clientes/resenas" element={<StubRoute />} />

              {/* ── Integraciones (todos stubs) ───────────────────── */}
              <Route path="/integraciones" element={<Navigate to="/integraciones/mercadopago" replace />} />
              <Route path="/integraciones/mercadopago" element={<StubRoute />} />
              <Route path="/integraciones/rappi" element={<StubRoute />} />
              <Route path="/integraciones/pedidosya" element={<StubRoute />} />
              <Route path="/integraciones/whatsapp" element={<StubRoute />} />
              <Route path="/integraciones/contabilidad" element={<StubRoute />} />
              <Route path="/integraciones/api" element={<StubRoute />} />

              {/* ── Configuración ─────────────────────────────────── */}
              <Route path="/configuracion" element={<Navigate to="/configuracion/local" replace />} />
              <Route path="/configuracion/local" element={<SettingsLocal />} />
              <Route path="/configuracion/branding" element={<StubRoute />} />
              <Route path="/configuracion/notificaciones" element={<StubRoute />} />
              <Route path="/configuracion/recibos" element={<StubRoute />} />
              <Route path="/configuracion/idioma" element={<StubRoute />} />
              <Route path="/configuracion/backup" element={<StubRoute />} />

              {/* ── Suscripción (todos stubs) ─────────────────────── */}
              <Route path="/suscripcion" element={<Navigate to="/suscripcion/plan" replace />} />
              <Route path="/suscripcion/plan" element={<StubRoute />} />
              <Route path="/suscripcion/facturacion" element={<StubRoute />} />
              <Route path="/suscripcion/metodos-pago" element={<StubRoute />} />
              <Route path="/suscripcion/historial" element={<StubRoute />} />
            </Route>

            {/* Rutas POS / Caja: requieren sesión Supabase + PIN POS */}
            <Route element={<AuthGate />}>
              <Route element={<PinGate />}>
                <Route element={<PosLayout />}>
                  <Route path="/" element={<DefaultModeRedirect />} />
                  <Route path="/pos" element={<DefaultModeRedirect />} />
                  <Route path="/pos/salon" element={<SalonView />} />
                  <Route path="/pos/mostrador" element={<MostradorView />} />
                  <Route path="/pos/pedidos" element={<PedidosHub />} />
                  <Route path="/pos/pedidos/:ventaId" element={<PedidoDetalle />} />
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
