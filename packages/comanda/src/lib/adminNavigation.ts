import {
  BarChart3, BookOpen, Utensils, Clock, DollarSign,
  Globe, Printer, Plug, Settings, CreditCard, Package, Store,
  type LucideIcon,
} from 'lucide-react';

// Single source of truth para el sidebar admin (sprint 6).
// Cada categoría tiene sub-items que se muestran al activarla.
// `requiredPermission`: si el usuario no lo tiene, la categoría/sub-item
// se oculta del sidebar (verificado en AdminCategoryItem con usePermiso).
//
// `badge`: 'soon' marca stubs (no implementado todavía); 'new'/'beta'
// reservados para futuro.

export interface NavSubItem {
  slug: string;
  label: string;
  href: string;
  requiredPermission?: string;
  badge?: 'new' | 'beta' | 'soon';
}

export interface NavCategory {
  slug: string;
  label: string;
  icon: LucideIcon;
  // href: a dónde navega el click en el header de la categoría (default
  // primer sub-item). Útil para overrides.
  href: string;
  requiredPermission?: string;
  subItems: NavSubItem[];
}

// Decisión 28-may noche (Lucas): los items con badge='soon' NO aparecen en
// sidebar hasta implementarse. Limpia visual y evita confusión.
// La fuente completa (incluidos soon) queda en ADMIN_NAVIGATION_FULL por
// si en el futuro queremos una pantalla "Roadmap" o un toggle "ver stubs".
const ADMIN_NAVIGATION_RAW: NavCategory[] = [
  {
    slug: 'reportes',
    label: 'Reportes',
    icon: BarChart3,
    href: '/reportes/dashboard',
    requiredPermission: 'comanda.reportes.ver',
    subItems: [
      { slug: 'dashboard',         label: 'Dashboard',          href: '/reportes/dashboard' },
      { slug: 'menu-engineering',  label: 'Menu Engineering',   href: '/reportes/menu-engineering' },
      { slug: 'cmv',               label: 'CMV (Costo merc.)',  href: '/reportes/cmv' },
      { slug: 'ventas',            label: 'Ventas detalle',     href: '/reportes/ventas' },
      { slug: 'productos',         label: 'Productos',          href: '/reportes/productos' },
      { slug: 'canales',           label: 'Canales',            href: '/reportes/canales' },
      { slug: 'empleados',         label: 'Performance empleados', href: '/reportes/empleados' },
      { slug: 'tiempos',           label: 'Tiempos',            href: '/reportes/tiempos' },
      { slug: 'auditoria',         label: 'Auditoría',          href: '/reportes/auditoria' },
    ],
  },
  {
    slug: 'menu',
    label: 'Menú',
    icon: BookOpen,
    href: '/menu/items',
    requiredPermission: 'comanda.catalogo.ver',
    subItems: [
      { slug: 'items',          label: 'Items',           href: '/menu/items' },
      { slug: 'grupos',         label: 'Grupos',          href: '/menu/grupos' },
      { slug: 'modificadores',  label: 'Modificadores',   href: '/menu/modificadores' },
      { slug: 'combos',         label: 'Combos',          href: '/menu/combos' },
      { slug: 'canales',        label: 'Canales',         href: '/menu/canales' },
      { slug: 'lista-precios',  label: 'Lista de precios', href: '/menu/lista-precios' },
      { slug: 'disponibilidad', label: 'Disponibilidad',  href: '/menu/disponibilidad' },
      // Mudanza 07-jun (Pieza E): insumos / materias primas / recetas se crean
      // y administran en PASE (Recetario), COMANDA solo consume. Sacados del nav
      // (las rutas siguen existiendo pero sin link). El CMV/alertas también en PASE.
      { slug: 'alertas-margen',  label: 'Alertas margen',  href: '/menu/alertas-margen' },
      { slug: 'revision',        label: 'Items por revisar', href: '/menu/revision' },
    ],
  },
  {
    slug: 'inventario',
    label: 'Inventario',
    icon: Package,
    href: '/inventario/alertas',
    requiredPermission: 'comanda.catalogo.ver',
    subItems: [
      { slug: 'alertas', label: 'Stock + alertas',  href: '/inventario/alertas' },
      { slug: 'mermas',  label: 'Cargar merma (one-tap)', href: '/inventario/mermas' },
      { slug: 'conteo',  label: 'Conteo físico',    href: '/inventario/conteo' },
      { slug: 'transferencias', label: 'Transferencias entre locales', href: '/inventario/transferencias' },
    ],
  },
  {
    slug: 'salon',
    label: 'Salón',
    icon: Utensils,
    href: '/salon/mesas',
    requiredPermission: 'comanda.salon.editar',
    subItems: [
      { slug: 'mesas',           label: 'Mesas',              href: '/salon/mesas' },
      { slug: 'servicios',       label: 'Servicios y turnos', href: '/salon/servicios', badge: 'soon' },
      // Reservas se gestionan en MESA. Este item es el cartel "se mudaron a MESA".
      // Config. reservas SACADA (limpieza 15-jul) → vive en MESA (Config reservas).
      { slug: 'reservas',        label: 'Reservas',           href: '/salon/reservas' },
    ],
  },
  {
    // Sección OPERATIVA del turno. Lo de gente/accesos se sacó (limpieza 15-jul):
    //  - Lista (RRHH) → PASE (Equipo)
    //  - Usuarios POS → Accesos (POS del local)
    //  - Permisos legacy → Accesos (Roles)
    // El slug queda 'empleados' porque las rutas viven en /empleados/* (no tocar
    // para no romper el resaltado activo ni App.tsx). Solo cambia el label.
    slug: 'empleados',
    label: 'Turno',
    icon: Clock,
    href: '/empleados/mi-cierre',
    requiredPermission: 'comanda.empleados.ver',
    subItems: [
      { slug: 'mi-cierre',     label: 'Mi cierre del día', href: '/empleados/mi-cierre' },
      { slug: 'propinas',      label: 'Reparto propinas', href: '/empleados/propinas' },
      { slug: 'horarios',      label: 'Trabajando ahora', href: '/empleados/horarios' },
      { slug: 'performance',   label: 'Performance',      href: '/empleados/performance', badge: 'soon' },
    ],
  },
  {
    slug: 'pagos',
    label: 'Pagos y caja',
    icon: DollarSign,
    href: '/pagos/metodos',
    requiredPermission: 'comanda.pagos.ver',
    subItems: [
      { slug: 'metodos',         label: 'Métodos de cobro',  href: '/pagos/metodos' },
      { slug: 'caja-chica',      label: 'Caja chica',        href: '/pagos/caja-chica',      badge: 'soon' },
      { slug: 'historico-turnos', label: 'Histórico turnos', href: '/pagos/historico-turnos', badge: 'soon' },
      { slug: 'logbook',         label: 'Logbook',           href: '/caja/logbook' },
      { slug: 'conciliacion-mp', label: 'Conciliación MP',   href: '/pagos/conciliacion-mp', badge: 'soon' },
      { slug: 'settlements',     label: 'Settlements',       href: '/pagos/settlements',     badge: 'soon' },
    ],
  },
  {
    // Hub del marketplace propio (15-jul): concentra estadísticas + configuración
    // + difusión de la tienda online. Rutas bajo /tienda-online (slug propio para
    // que el resaltado no choque con la categoría 'online').
    slug: 'tienda-online',
    label: 'Tienda online',
    icon: Store,
    href: '/tienda-online',
    requiredPermission: 'comanda.online.gestionar',
    subItems: [
      { slug: 'resumen',       label: 'Resumen',       href: '/tienda-online' },
      { slug: 'configuracion', label: 'Configuración', href: '/tienda-online/configuracion' },
      { slug: 'difusion',      label: 'Difusión',      href: '/tienda-online/difusion' },
    ],
  },
  {
    slug: 'online',
    label: 'Online',
    icon: Globe,
    href: '/online/menu-qr',
    requiredPermission: 'comanda.online.gestionar',
    subItems: [
      { slug: 'menu-qr',  label: 'Menú QR',       href: '/online/menu-qr' },
      { slug: 'kds',      label: 'KDS',           href: '/online/kds' },
      { slug: 'tracking', label: 'Tracking pedidos', href: '/online/tracking', badge: 'soon' },
      { slug: 'dispatch', label: 'Despacho delivery (mapa)', href: '/online/dispatch' },
    ],
  },
  {
    slug: 'hardware',
    label: 'Hardware',
    icon: Printer,
    href: '/hardware/estaciones',
    requiredPermission: 'comanda.hardware.gestionar',
    subItems: [
      { slug: 'estaciones',  label: 'Estaciones',     href: '/hardware/estaciones' },
      { slug: 'impresoras',  label: 'Impresoras',     href: '/hardware/impresoras' },
      { slug: 'agentes',     label: 'Print Agents (PCs)', href: '/hardware/agentes' },
      { slug: 'riders',      label: 'Repartidores',   href: '/hardware/riders' },
      { slug: 'cajon',       label: 'Cajón de dinero', href: '/hardware/cajon',      badge: 'soon' },
      { slug: 'mp-point',    label: 'MP Point',       href: '/hardware/mp-point',    badge: 'soon' },
      { slug: 'tablets-kds', label: 'Tablets KDS',    href: '/hardware/tablets-kds', badge: 'soon' },
    ],
  },
  // Secciones Marketing y Clientes SACADAS del sidebar (limpieza 15-jul):
  //  - Marketing (Cupones, Fidelidad, Campañas) → Habitué; Eventos/Giftcards → MESA.
  //  - Clientes (Comensales, Historial) → Habitué; Reseñas → MESA/Habitué.
  // Las rutas siguen en App.tsx por si se necesita volver, pero no tienen link.
  {
    slug: 'integraciones',
    label: 'Integraciones',
    icon: Plug,
    href: '/integraciones/mercadopago',
    requiredPermission: 'comanda.integraciones.gestionar',
    subItems: [
      { slug: 'mercadopago',   label: 'Mercado Pago',     href: '/integraciones/mercadopago',   badge: 'soon' },
      { slug: 'rappi',         label: 'Rappi',            href: '/integraciones/rappi' },
      { slug: 'pedidosya',     label: 'PedidosYa',        href: '/integraciones/pedidosya' },
      { slug: 'deliverect',    label: 'Deliverect',       href: '/integraciones/deliverect' },
      { slug: 'whatsapp',      label: 'WhatsApp Business', href: '/integraciones/whatsapp',     badge: 'soon' },
      { slug: 'contabilidad',  label: 'Contabilidad',     href: '/integraciones/contabilidad',  badge: 'soon' },
      { slug: 'api',           label: 'Webhooks / API',   href: '/integraciones/api',           badge: 'soon' },
    ],
  },
  {
    slug: 'configuracion',
    label: 'Configuración',
    icon: Settings,
    href: '/configuracion/local',
    requiredPermission: 'comanda.configuracion.editar',
    subItems: [
      { slug: 'local',          label: 'Local',                 href: '/configuracion/local' },
      { slug: 'cubiertos',      label: 'Cubierto por sector',   href: '/configuracion/cubiertos' },
      { slug: 'integraciones',  label: 'Integraciones (WhatsApp, Email, Stripe…)', href: '/configuracion/integraciones' },
      { slug: 'afip',           label: 'Factura electrónica AFIP', href: '/configuracion/afip' },
      { slug: 'afip-pendientes', label: 'AFIP pendientes (reintentar)', href: '/configuracion/afip-pendientes' },
      { slug: 'branding',       label: 'Branding y logos',      href: '/configuracion/branding',       badge: 'soon' },
      { slug: 'notificaciones', label: 'Notificaciones',        href: '/configuracion/notificaciones', badge: 'soon' },
      { slug: 'recibos',        label: 'Recibos e impresión',   href: '/configuracion/recibos',        badge: 'soon' },
      { slug: 'idioma',         label: 'Idioma y zona horaria', href: '/configuracion/idioma',         badge: 'soon' },
      { slug: 'backup',         label: 'Backup y exportación',  href: '/configuracion/backup',         badge: 'soon' },
    ],
  },
  {
    slug: 'suscripcion',
    label: 'Suscripción',
    icon: CreditCard,
    href: '/suscripcion/plan',
    requiredPermission: 'comanda.suscripcion.gestionar',
    subItems: [
      { slug: 'plan',         label: 'Plan actual',        href: '/suscripcion/plan',         badge: 'soon' },
      { slug: 'facturacion',  label: 'Facturación',        href: '/suscripcion/facturacion',  badge: 'soon' },
      { slug: 'metodos-pago', label: 'Métodos de pago',    href: '/suscripcion/metodos-pago', badge: 'soon' },
      { slug: 'historial',    label: 'Historial de pagos', href: '/suscripcion/historial',    badge: 'soon' },
    ],
  },
];

// Sub-items sin permiso propio → se les estampa `comanda.nav.<cat>.<sub>`
// (namespace de NAVEGACIÓN, separado de los permisos de acción comanda.*).
// El sidebar (AdminCategoryItem) y el guard de ruta (AdminLayout) ocultan/
// bloquean el sub-item si el user no lo tiene. Así "dar Reportes pero no
// Dashboard" es real. Ver catálogo espejo en accesos/src/lib/permisosComanda.ts.
function stampNavPerms(nav: NavCategory[]): NavCategory[] {
  return nav.map((cat) => ({
    ...cat,
    subItems: cat.subItems.map((s) => ({
      ...s,
      requiredPermission: s.requiredPermission ?? `comanda.nav.${cat.slug}.${s.slug}`,
    })),
  }));
}

const ADMIN_NAVIGATION_FULL: NavCategory[] = stampNavPerms(ADMIN_NAVIGATION_RAW);

// Filtra items con badge='soon'. Si una categoría queda sin sub-items
// después del filtro, también se oculta (no tiene sentido un acordeón
// vacío). Si su href apuntaba a un sub-item soon, se reemplaza por el
// primer sub-item visible.
function filterSoon(nav: NavCategory[]): NavCategory[] {
  return nav
    .map((cat) => {
      const visibleSubs = cat.subItems.filter((s) => s.badge !== 'soon');
      if (visibleSubs.length === 0) return null;
      const wasSoonHref = cat.subItems.find((s) => s.href === cat.href)?.badge === 'soon';
      return {
        ...cat,
        subItems: visibleSubs,
        href: wasSoonHref ? visibleSubs[0]!.href : cat.href,
      };
    })
    .filter((c): c is NavCategory => c !== null);
}

/** Sidebar visible para el usuario — sin items "Próximamente". */
export const ADMIN_NAVIGATION: NavCategory[] = filterSoon(ADMIN_NAVIGATION_FULL);

/** Catálogo completo incluyendo stubs (badge='soon'). Útil para roadmap/debug. */
export { ADMIN_NAVIGATION_FULL };

// Encontrar la categoría / sub-item activo según pathname.
export function findActiveCategory(pathname: string): NavCategory | null {
  return ADMIN_NAVIGATION.find((cat) =>
    pathname === `/${cat.slug}` ||
    pathname.startsWith(`/${cat.slug}/`),
  ) ?? null;
}

export function findActiveSubItem(category: NavCategory, pathname: string): NavSubItem | null {
  // Coincidencia exacta primero, luego startsWith para sub-rutas.
  return category.subItems.find((s) => s.href === pathname)
    ?? category.subItems.find((s) => pathname.startsWith(s.href + '/'))
    ?? null;
}
