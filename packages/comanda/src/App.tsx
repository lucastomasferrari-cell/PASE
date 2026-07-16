import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';
import { initConsoleCapture } from './lib/consoleCapture';
// Side-effect: expone window.__comandaCleanupOffline + Nuclear para debugging
// del state offline (ventas zombies, pending_ops trabadas). Sprint cierre 2-jun.
import './lib/db/cleanup';
// Capturar errores de consola desde el boot, ANTES de cualquier otro código.
// Los errores se incluyen en tickets de soporte para que el agent auto-fix
// tenga contexto del browser al diagnosticar.
initConsoleCapture();

import { AuthProvider } from './lib/AuthProvider';
import { AuthPosProvider } from './lib/AuthPosProvider';
import { SyncEngineLifecycle } from './lib/sync/SyncEngineLifecycle';
import { featureFlags } from './lib/featureFlags';
// Lazy: RxDB (pesado) solo se baja cuando el flag offline-first está ON.
// Con el flag OFF (default) este chunk no se carga → cero peso muerto.
const OfflineProvider = lazy(() => import('./lib/offline2/OfflineProvider').then(m => ({ default: m.OfflineProvider })));
import { SoporteWidget } from './components/SoporteWidget';
import { PWAUpdatePrompt } from './components/PWAUpdatePrompt';
import { RedirectIfAuth } from './components/RedirectIfAuth';
import { PinGate } from './components/PinGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './lib/auth';

// LoginPage queda eager — entry point sin sesión, no queremos latencia (regla C8).
import { LoginPage } from './pages/Login/LoginPage';
// WelcomePage — selector Admin/POS, es la puerta de entrada cuando no hay
// sesión. También eager por la misma razón que LoginPage.
import { WelcomePage } from './pages/Welcome/WelcomePage';

// ─── Componentes core compartidos (no son páginas, no van a lazy) ──────────
import { DefaultModeRedirect } from './components/DefaultModeRedirect';
import { AdminLayout } from './components/admin/AdminLayout';
import { StubRoute } from './pages/admin-stubs/StubRoute';
// AUDIT F3B#2: routeWrappers tiene eager-imports de 6 tabs admin (1.882 LOC
// + sus deps de UI) que entraban al bundle inicial aunque el user nunca abriera
// admin. Pasar a lazy individual viola un poco la simetría pero respeta regla C8.
const ItemsRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ItemsRoute })));
const GruposRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.GruposRoute })));
const CanalesRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.CanalesRoute })));
const ListaPreciosRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ListaPreciosRoute })));
const ModificadoresRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ModificadoresRoute })));
const EmpleadosListaRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.EmpleadosListaRoute })));
// Menú Marca — wrappers con forceScope='maestro' para las rutas dueño-only.
const ItemsRouteMaestro = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ItemsRouteMaestro })));
const GruposRouteMaestro = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.GruposRouteMaestro })));
const ListaPreciosRouteMaestro = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ListaPreciosRouteMaestro })));

// ─── LAZY: regla C8 (auditoría 2026-05-15). Todas las páginas son
// named exports, así que usamos el patrón `.then(m => ({ default: m.X }))`
// para no tocar los archivos fuente. Si en el futuro consolidamos los
// archivos a `export default`, simplificamos a `lazy(() => import(...))`.
// ────────────────────────────────────────────────────────────────────────

// Caja (rutas POS)
const CajaAbrir = lazy(() => import('./pages/Caja/CajaAbrir').then(m => ({ default: m.CajaAbrir })));
const CajaEstado = lazy(() => import('./pages/Caja/CajaEstado').then(m => ({ default: m.CajaEstado })));
const CajaCerrar = lazy(() => import('./pages/Caja/CajaCerrar').then(m => ({ default: m.CajaCerrar })));
const CajaHistorico = lazy(() => import('./pages/Caja/CajaHistorico').then(m => ({ default: m.CajaHistorico })));
const PartesOperativos = lazy(() => import('./pages/Caja/PartesOperativos').then(m => ({ default: m.PartesOperativos })));
const Logbook = lazy(() => import('./pages/Caja/Logbook').then(m => ({ default: m.Logbook })));

// POS
const PosLayout = lazy(() => import('./pages/Pos/PosLayout').then(m => ({ default: m.PosLayout })));
const SalonView = lazy(() => import('./pages/Pos/SalonView').then(m => ({ default: m.SalonView })));
const MostradorView = lazy(() => import('./pages/Pos/MostradorView').then(m => ({ default: m.MostradorView })));
const PedidosHub = lazy(() => import('./pages/Pos/PedidosHub').then(m => ({ default: m.PedidosHub })));
const PedidoDetalle = lazy(() => import('./pages/Pos/PedidoDetalle').then(m => ({ default: m.PedidoDetalle })));
const VentaScreen = lazy(() => import('./pages/Pos/VentaScreen').then(m => ({ default: m.VentaScreen })));
const HandheldView = lazy(() => import('./pages/Pos/HandheldView').then(m => ({ default: m.HandheldView })));

// Rutas públicas (sin auth, sin PIN) — sprint 4 sesión B + sprint 5 Roc-N-Ramen
const TiendaLayout = lazy(() => import('./pages/Tienda/TiendaLayout').then(m => ({ default: m.TiendaLayout })));
const MarketplaceHome = lazy(() => import('./pages/Marketplace/MarketplaceHome').then(m => ({ default: m.MarketplaceHome })));
const TiendaHome = lazy(() => import('./pages/Tienda/TiendaHome').then(m => ({ default: m.TiendaHome })));
const TiendaItemDetalle = lazy(() => import('./pages/Tienda/TiendaItemDetalle').then(m => ({ default: m.TiendaItemDetalle })));
const TiendaCheckout = lazy(() => import('./pages/Tienda/TiendaCheckout').then(m => ({ default: m.TiendaCheckout })));
const TiendaConfirmacion = lazy(() => import('./pages/Tienda/TiendaConfirmacion').then(m => ({ default: m.TiendaConfirmacion })));
const TiendaSeguimiento = lazy(() => import('./pages/Tienda/TiendaSeguimiento').then(m => ({ default: m.TiendaSeguimiento })));
const KdsView = lazy(() => import('./pages/Kds/KdsView').then(m => ({ default: m.KdsView })));
const MenuQrView = lazy(() => import('./pages/MenuQr/MenuQrView').then(m => ({ default: m.MenuQrView })));

// Admin — Reportes
const ReportesLayout = lazy(() => import('./pages/Reportes/ReportesLayout').then(m => ({ default: m.ReportesLayout })));
const ReportesDashboard = lazy(() => import('./pages/Reportes/Dashboard').then(m => ({ default: m.Dashboard })));
const ReporteCanales = lazy(() => import('./pages/Reportes/ReporteCanales').then(m => ({ default: m.ReporteCanales })));
const ReporteProductos = lazy(() => import('./pages/Reportes/ReporteProductos').then(m => ({ default: m.ReporteProductos })));
const ReporteTiempos = lazy(() => import('./pages/Reportes/ReporteTiempos').then(m => ({ default: m.ReporteTiempos })));
const ReporteMenuEngineering = lazy(() => import('./pages/Reportes/ReporteMenuEngineering').then(m => ({ default: m.ReporteMenuEngineering })));
const ReporteCMV = lazy(() => import('./pages/Reportes/ReporteCMV').then(m => ({ default: m.ReporteCMV })));
const PropinasReparto = lazy(() => import('./pages/Empleados/PropinasReparto').then(m => ({ default: m.PropinasReparto })));
const FidelidadLista = lazy(() => import('./pages/Marketing/FidelidadLista').then(m => ({ default: m.FidelidadLista })));
const CajaChica = lazy(() => import('./pages/Caja/CajaChica').then(m => ({ default: m.CajaChica })));
const EmpleadosTrabajando = lazy(() => import('./pages/Empleados/EmpleadosTrabajando').then(m => ({ default: m.EmpleadosTrabajando })));
const MiCierreView = lazy(() => import('./pages/Empleados/MiCierre').then(m => ({ default: m.MiCierreView })));
const UsuariosPosPage = lazy(() => import('./pages/Empleados/UsuariosPosPage'));
const ReporteVentas = lazy(() => import('./pages/Reportes/ReporteVentas').then(m => ({ default: m.ReporteVentas })));
const SettingsRecibos = lazy(() => import('./pages/Configuracion/SettingsRecibos').then(m => ({ default: m.SettingsRecibos })));
const ReportePerformanceEmpleados = lazy(() => import('./pages/Reportes/ReportePerformanceEmpleados').then(m => ({ default: m.ReportePerformanceEmpleados })));
const TrackingDelivery = lazy(() => import('./pages/Online/TrackingDelivery').then(m => ({ default: m.TrackingDelivery })));
const ConciliacionMpView = lazy(() => import('./pages/Caja/ConciliacionMpView').then(m => ({ default: m.ConciliacionMpView })));
const SettingsBranding = lazy(() => import('./pages/Configuracion/SettingsBranding').then(m => ({ default: m.SettingsBranding })));
const SettingsCubiertos = lazy(() => import('./pages/Configuracion/SettingsCubiertos').then(m => ({ default: m.SettingsCubiertos })));
const IntegracionWhatsapp = lazy(() => import('./pages/Integraciones/IntegracionWhatsapp').then(m => ({ default: m.IntegracionWhatsapp })));
const MateriasPrimasLista = lazy(() => import('./pages/Catalogo/MateriasPrimasLista').then(m => ({ default: m.MateriasPrimasLista })));
const CombosLista = lazy(() => import('./pages/Catalogo/CombosLista').then(m => ({ default: m.CombosLista })));
const LogWebhooksExternos = lazy(() => import('./pages/Integraciones/LogWebhooksExternos').then(m => ({ default: m.LogWebhooksExternos })));
const ConectarPartners = lazy(() => import('./pages/Integraciones/ConectarPartners').then(m => ({ default: m.ConectarPartners })));

// Admin — Clientes (F1.2)
const ClientesLista = lazy(() => import('./pages/Clientes/ClientesLista').then(m => ({ default: m.ClientesLista })));
const ResenasAdmin = lazy(() => import('./pages/Clientes/ResenasAdmin').then(m => ({ default: m.ResenasAdmin })));

// Admin — CMV: Insumos + Recetas (F1.1b)
const InsumosLista = lazy(() => import('./pages/Catalogo/InsumosLista').then(m => ({ default: m.InsumosLista })));
const RecetasLista = lazy(() => import('./pages/Catalogo/RecetasLista').then(m => ({ default: m.RecetasLista })));
const RecetasImportar = lazy(() => import('./pages/Catalogo/RecetasImportar').then(m => ({ default: m.RecetasImportar })));
const AlertasMargenLista = lazy(() => import('./pages/Catalogo/AlertasMargenLista').then(m => ({ default: m.AlertasMargenLista })));
const ItemReviewQueue = lazy(() => import('./pages/Catalogo/ItemReviewQueue').then(m => ({ default: m.ItemReviewQueue })));

// Admin — 86 list (disponibilidad)
const DisponibilidadLista = lazy(() => import('./pages/Catalogo/DisponibilidadLista').then(m => ({ default: m.DisponibilidadLista })));

// Admin — Settings
const SettingsLocal = lazy(() => import('./pages/Settings/SettingsLocal').then(m => ({ default: m.SettingsLocal })));
const SettingsAfip = lazy(() => import('./pages/Settings/SettingsAfip').then(m => ({ default: m.SettingsAfip })));
const AfipPendientes = lazy(() => import('./pages/Settings/AfipPendientes').then(m => ({ default: m.AfipPendientes })));
const SettingsIntegraciones = lazy(() => import('./pages/Settings/SettingsIntegraciones').then(m => ({ default: m.SettingsIntegraciones })));
const IntegracionPartnerScreen = lazy(() => import('./pages/Integraciones/IntegracionPartnerScreen').then(m => ({ default: m.IntegracionPartnerScreen })));
const HardwareImpresoras = lazy(() => import('./pages/Hardware/HardwareImpresoras').then(m => ({ default: m.HardwareImpresoras })));
const HardwareAgentes = lazy(() => import('./pages/Hardware/HardwareAgentes').then(m => ({ default: m.HardwareAgentes })));
const HardwareRiders = lazy(() => import('./pages/Hardware/HardwareRiders').then(m => ({ default: m.HardwareRiders })));
const DispatchMap = lazy(() => import('./pages/Delivery/DispatchMap').then(m => ({ default: m.DispatchMap })));
const RiderPWA = lazy(() => import('./pages/Rider/RiderPWA').then(m => ({ default: m.RiderPWA })));
const InventarioAlertas = lazy(() => import('./pages/Inventario/InventarioAlertas').then(m => ({ default: m.InventarioAlertas })));
const InventarioConteo = lazy(() => import('./pages/Inventario/InventarioConteo').then(m => ({ default: m.InventarioConteo })));
const InventarioTransferencias = lazy(() => import('./pages/Inventario/InventarioTransferencias').then(m => ({ default: m.InventarioTransferencias })));
const MermasOneTap = lazy(() => import('./pages/Inventario/MermasOneTap').then(m => ({ default: m.MermasOneTap })));
const CuponesAdmin = lazy(() => import('./pages/Marketing/CuponesAdmin').then(m => ({ default: m.CuponesAdmin })));
const EventosGiftcardsAdmin = lazy(() => import('./pages/Marketing/EventosGiftcardsAdmin').then(m => ({ default: m.EventosGiftcardsAdmin })));
const SettingsMesas = lazy(() => import('./pages/Settings/SettingsMesas').then(m => ({ default: m.SettingsMesas })));
const SettingsReservas = lazy(() => import('./pages/Settings/SettingsReservas').then(m => ({ default: m.SettingsReservas })));
const SettingsMetodosCobro = lazy(() => import('./pages/Settings/SettingsMetodosCobro').then(m => ({ default: m.SettingsMetodosCobro })));
const SettingsPermisos = lazy(() => import('./pages/Settings/SettingsPermisos').then(m => ({ default: m.SettingsPermisos })));
const SettingsAuditoria = lazy(() => import('./pages/Settings/SettingsAuditoria').then(m => ({ default: m.SettingsAuditoria })));
const SettingsKds = lazy(() => import('./pages/Settings/SettingsKds').then(m => ({ default: m.SettingsKds })));
const SettingsMenuQr = lazy(() => import('./pages/Settings/SettingsMenuQr').then(m => ({ default: m.SettingsMenuQr })));
const TiendaOnlineHub = lazy(() => import('./pages/Online/TiendaOnlineHub').then(m => ({ default: m.TiendaOnlineHub })));
const SettingsEstaciones = lazy(() => import('./pages/Settings/SettingsEstaciones').then(m => ({ default: m.SettingsEstaciones })));
// SPIKE OFFLINE (descartable, solo dev) — sandbox de validación de motor local-first.
const SpikeOfflinePage = lazy(() => import('./spike-offline/SpikeOfflinePage').then(m => ({ default: m.SpikeOfflinePage })));

// ─── Loader fallback para Suspense (full-page) ────────────────────────────
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground bg-background">
      Cargando…
    </div>
  );
}

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
  if (!user) return <Navigate to="/welcome" replace />;
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
  // `import.meta.env.BASE_URL` refleja el `base` de vite.config. Post cleanup
  // 22-may noche (COMANDA con URL propia) siempre es "/" — el modo embebido
  // en PASE bajo /comanda-app/ fue eliminado. Mantengo el `replace` por si en
  // el futuro vuelve a embebirse o se sirve bajo un sub-path.
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <AuthProvider>
      <BrowserRouter basename={basename}>
        <AuthPosProvider>
          <SyncEngineLifecycle />
          {/* Widget de soporte flotante. Solo renderiza si el user está
              logueado (chequea adentro). Llama a /api/claude con
              task=soporte-chat y persiste tickets en tickets_soporte. */}
          <SoporteWidget />
          {/* PWA update prompt: detecta nuevo deploy y muestra toast
              "actualizar ahora". Reemplaza el autoUpdate viejo que dejaba
              al usuario con la versión cacheada hasta cerrar todas las tabs. */}
          <PWAUpdatePrompt />
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
            <Suspense fallback={<PageLoader />}>
              <Routes>
                {import.meta.env.DEV && <Route path="/pos/_spike-offline" element={<SpikeOfflinePage />} />}
                <Route path="/login" element={<RedirectIfAuth><LoginPage /></RedirectIfAuth>} />
                <Route path="/welcome" element={<WelcomePage />} />
                {/* Raíz: siempre la Welcome (selector Admin/POS) aunque haya
                    sesión. Cada botón manda a /login?next= — RedirectIfAuth
                    respeta el next y te lleva al destino sin re-loguear. */}
                <Route path="/" element={<WelcomePage />} />

                {/* Rutas PÚBLICAS (sin auth, sin PIN) */}
                <Route path="/marketplace" element={<MarketplaceHome />} />
                <Route path="/tienda/:localSlug" element={<TiendaLayout />}>
                  <Route index element={<TiendaHome />} />
                  <Route path="item/:itemId" element={<TiendaItemDetalle />} />
                  <Route path="checkout" element={<TiendaCheckout />} />
                  <Route path="confirmacion/:ventaId" element={<TiendaConfirmacion />} />
                  <Route path="seguimiento" element={<TiendaSeguimiento />} />
                </Route>
                <Route path="/kds/:estacion" element={<KdsView />} />
                <Route path="/menu/:token" element={<MenuQrView />} />
                <Route path="/r/:token" element={<RiderPWA />} />

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
                    <Route path="menu-engineering" element={<ReporteMenuEngineering />} />
                    <Route path="cmv" element={<ReporteCMV />} />
                    <Route path="ventas" element={<ReporteVentas />} />
                    <Route path="empleados" element={<ReportePerformanceEmpleados />} />
                  </Route>
                  <Route path="/reportes/auditoria" element={<SettingsAuditoria />} />
                  {/* /reportes/ventas ahora vive bajo el layout — ver Route 'ventas' arriba */}
                  {/* /reportes/empleados ahora bajo el layout — ver 'empleados' arriba */}

                  {/* ── Menú (catálogo) ───────────────────────────────── */}
                  <Route path="/menu" element={<Navigate to="/menu/items" replace />} />
                  <Route path="/menu/items" element={<ItemsRoute />} />
                  <Route path="/menu/grupos" element={<GruposRoute />} />
                  <Route path="/menu/canales" element={<CanalesRoute />} />
                  <Route path="/menu/lista-precios" element={<ListaPreciosRoute />} />
                  <Route path="/menu/modificadores" element={<ModificadoresRoute />} />
                  <Route path="/menu/combos" element={<StubRoute />} />
                  <Route path="/menu/disponibilidad" element={<DisponibilidadLista />} />
                  {/* ── Menú Marca (maestro — dueño-only) ─────────────── */}
                  <Route path="/menu/maestro" element={<Navigate to="/menu/maestro/items" replace />} />
                  <Route path="/menu/maestro/items" element={<ItemsRouteMaestro />} />
                  <Route path="/menu/maestro/grupos" element={<GruposRouteMaestro />} />
                  <Route path="/menu/maestro/lista-precios" element={<ListaPreciosRouteMaestro />} />
                  {/* F1.1b CMV — insumos + recetas + materias primas + alertas margen */}
                  <Route path="/menu/insumos" element={<InsumosLista />} />

                  {/* ── Inventario ─────────────────────────────────────── */}
                  <Route path="/inventario" element={<Navigate to="/inventario/alertas" replace />} />
                  <Route path="/inventario/alertas" element={<InventarioAlertas />} />
                  <Route path="/inventario/conteo" element={<InventarioConteo />} />
                  <Route path="/inventario/mermas" element={<MermasOneTap />} />
                  <Route path="/inventario/transferencias" element={<InventarioTransferencias />} />
                  <Route path="/menu/recetas" element={<RecetasLista />} />
                  <Route path="/menu/recetas/importar" element={<RecetasImportar />} />
                  <Route path="/menu/alertas-margen" element={<AlertasMargenLista />} />
                  <Route path="/menu/revision" element={<ItemReviewQueue />} />
                  <Route path="/menu/materias-primas" element={<MateriasPrimasLista />} />
                  <Route path="/menu/combos" element={<CombosLista />} />

                  {/* ── Salón ─────────────────────────────────────────── */}
                  <Route path="/salon" element={<Navigate to="/salon/mesas" replace />} />
                  <Route path="/salon/mesas" element={<SettingsMesas />} />
                  <Route path="/salon/servicios" element={<StubRoute />} />
                  <Route path="/salon/config-reservas" element={<SettingsReservas />} />

                  {/* ── Empleados ─────────────────────────────────────── */}
                  <Route path="/empleados" element={<Navigate to="/empleados/lista" replace />} />
                  <Route path="/empleados/lista" element={<EmpleadosListaRoute />} />
                  <Route path="/empleados/permisos" element={<SettingsPermisos />} />
                  {/* Sprint COMANDA Autónomo Fase 2.b (24-may noche): gestión
                      de usuarios POS nativa de COMANDA (antes vivía en PASE). */}
                  <Route path="/empleados/usuarios-pos" element={<UsuariosPosPage />} />
                  <Route path="/empleados/horarios" element={<EmpleadosTrabajando />} />
                  <Route path="/empleados/performance" element={<StubRoute />} />
                  <Route path="/empleados/propinas" element={<PropinasReparto />} />
                  <Route path="/empleados/mi-cierre" element={<MiCierreView />} />

                  {/* ── Pagos y caja ──────────────────────────────────── */}
                  <Route path="/pagos" element={<Navigate to="/pagos/metodos" replace />} />
                  <Route path="/pagos/metodos" element={<SettingsMetodosCobro />} />
                  <Route path="/pagos/caja-chica" element={<CajaChica />} />
                  <Route path="/pagos/historico-turnos" element={<Navigate to="/caja/historico" replace />} />
                  <Route path="/pagos/conciliacion-mp" element={<ConciliacionMpView />} />
                  <Route path="/pagos/settlements" element={<StubRoute />} />

                  {/* ── Online ────────────────────────────────────────── */}
                  <Route path="/online" element={<Navigate to="/online/menu-qr" replace />} />
                  <Route path="/online/menu-qr" element={<SettingsMenuQr />} />
                  <Route path="/online/kds" element={<SettingsKds />} />
                  <Route path="/tienda-online" element={<TiendaOnlineHub />} />
                  <Route path="/tienda-online/configuracion" element={<TiendaOnlineHub />} />
                  <Route path="/tienda-online/difusion" element={<TiendaOnlineHub />} />
                  <Route path="/online/tienda" element={<Navigate to="/tienda-online" replace />} />
                  <Route path="/online/tracking" element={<TrackingDelivery />} />
                  <Route path="/online/dispatch" element={<DispatchMap />} />

                  {/* ── Hardware ──────────────────────────────────────── */}
                  <Route path="/hardware" element={<Navigate to="/hardware/estaciones" replace />} />
                  <Route path="/hardware/estaciones" element={<SettingsEstaciones />} />
                  <Route path="/hardware/impresoras" element={<HardwareImpresoras />} />
                  <Route path="/hardware/agentes" element={<HardwareAgentes />} />
                  <Route path="/hardware/riders" element={<HardwareRiders />} />
                  <Route path="/hardware/cajon" element={<StubRoute />} />
                  <Route path="/hardware/mp-point" element={<StubRoute />} />
                  <Route path="/hardware/tablets-kds" element={<StubRoute />} />

                  {/* ── Marketing (todos stubs) ───────────────────────── */}
                  <Route path="/marketing" element={<Navigate to="/marketing/promociones" replace />} />
                  <Route path="/marketing/promociones" element={<StubRoute />} />
                  <Route path="/marketing/cupones" element={<CuponesAdmin />} />
                  <Route path="/marketing/eventos" element={<EventosGiftcardsAdmin />} />
                  <Route path="/marketing/fidelidad" element={<FidelidadLista />} />
                  <Route path="/marketing/campanas" element={<StubRoute />} />

                  {/* ── Clientes — F1.2 lista funcional, resto stub ───── */}
                  <Route path="/clientes" element={<Navigate to="/clientes/lista" replace />} />
                  <Route path="/clientes/lista" element={<ClientesLista />} />
                  <Route path="/clientes/historial" element={<StubRoute />} />
                  <Route path="/clientes/resenas" element={<ResenasAdmin />} />

                  {/* ── Integraciones (todos stubs) ───────────────────── */}
                  <Route path="/integraciones" element={<Navigate to="/integraciones/mercadopago" replace />} />
                  <Route path="/integraciones/mercadopago" element={<ConectarPartners />} />
                  <Route path="/integraciones/conectar" element={<ConectarPartners />} />
                  <Route path="/integraciones/rappi" element={<IntegracionPartnerScreen provider="rappi" />} />
                  <Route path="/integraciones/pedidosya" element={<IntegracionPartnerScreen provider="pedidos-ya" />} />
                  <Route path="/integraciones/webhooks" element={<LogWebhooksExternos />} />
                  <Route path="/integraciones/whatsapp" element={<IntegracionWhatsapp />} />
                  <Route path="/integraciones/contabilidad" element={<StubRoute />} />
                  <Route path="/integraciones/api" element={<StubRoute />} />

                  {/* ── Configuración ─────────────────────────────────── */}
                  <Route path="/configuracion" element={<Navigate to="/configuracion/local" replace />} />
                  <Route path="/configuracion/local" element={<SettingsLocal />} />
                  <Route path="/configuracion/afip" element={<SettingsAfip />} />
                  <Route path="/configuracion/afip-pendientes" element={<AfipPendientes />} />
                  <Route path="/configuracion/integraciones" element={<SettingsIntegraciones />} />
                  <Route path="/configuracion/branding" element={<SettingsBranding />} />
                  <Route path="/configuracion/cubiertos" element={<SettingsCubiertos />} />
                  <Route path="/configuracion/notificaciones" element={<SettingsRecibos />} />
                  <Route path="/configuracion/recibos" element={<SettingsRecibos />} />
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
                    {/* offline2 (rebuild estilo Toast): cuando el flag está ON,
                        montamos el motor RxDB UNA vez sobre el subárbol POS. Con
                        el flag OFF (default) no monta nada → cero impacto. */}
                    <Route element={featureFlags.offlineFirstVentas
                      ? <OfflineProvider><PosLayout /></OfflineProvider>
                      : <PosLayout />}>
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
                      <Route path="/caja/partes" element={<PartesOperativos />} />
                      <Route path="/caja/logbook" element={<Logbook />} />
                    </Route>
                    {/* Handheld mozo: layout propio full-screen mobile-first, NO usa PosLayout */}
                    <Route path="/pos/handheld" element={<HandheldView />} />
                  </Route>
                </Route>

                <Route path="*" element={<Navigate to="/pos" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </AuthPosProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
