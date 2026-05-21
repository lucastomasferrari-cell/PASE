import {
  BarChart3, BookOpen, Utensils, Users, DollarSign,
  Globe, Printer, Megaphone, User, Plug, Settings, CreditCard, Package,
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

export const ADMIN_NAVIGATION: NavCategory[] = [
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
      // F1.1b CMV: insumos + recetas + materias primas (proveedor-específicas).
      { slug: 'insumos',         label: 'Insumos',         href: '/menu/insumos' },
      { slug: 'materias-primas', label: 'Materias primas', href: '/menu/materias-primas' },
      { slug: 'recetas',         label: 'Recetas',         href: '/menu/recetas' },
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
      { slug: 'mesas',     label: 'Mesas',              href: '/salon/mesas' },
      { slug: 'servicios', label: 'Servicios y turnos', href: '/salon/servicios', badge: 'soon' },
      { slug: 'reservas',  label: 'Reservas',           href: '/salon/reservas' },
    ],
  },
  {
    slug: 'empleados',
    label: 'Empleados',
    icon: Users,
    href: '/empleados/lista',
    requiredPermission: 'comanda.empleados.ver',
    subItems: [
      { slug: 'lista',       label: 'Lista',             href: '/empleados/lista' },
      { slug: 'permisos',    label: 'Permisos',          href: '/empleados/permisos' },
      { slug: 'mi-cierre',   label: 'Mi cierre del día',  href: '/empleados/mi-cierre' },
      { slug: 'propinas',    label: 'Reparto propinas',  href: '/empleados/propinas' },
      { slug: 'horarios',    label: 'Trabajando ahora',  href: '/empleados/horarios' },
      { slug: 'performance', label: 'Performance',       href: '/empleados/performance', badge: 'soon' },
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
    slug: 'online',
    label: 'Online',
    icon: Globe,
    href: '/online/tienda',
    requiredPermission: 'comanda.online.gestionar',
    subItems: [
      { slug: 'tienda',   label: 'Tienda online', href: '/online/tienda',   badge: 'soon' },
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
  {
    slug: 'marketing',
    label: 'Marketing',
    icon: Megaphone,
    href: '/marketing/promociones',
    requiredPermission: 'comanda.marketing.gestionar',
    subItems: [
      { slug: 'promociones', label: 'Promociones y descuentos', href: '/marketing/promociones', badge: 'soon' },
      { slug: 'cupones',     label: 'Cupones',                  href: '/marketing/cupones' },
      { slug: 'fidelidad',   label: 'Programa de fidelidad',    href: '/marketing/fidelidad',   badge: 'soon' },
      { slug: 'campanas',    label: 'Email/WhatsApp campaigns', href: '/marketing/campanas',    badge: 'soon' },
    ],
  },
  {
    slug: 'clientes',
    label: 'Clientes',
    icon: User,
    href: '/clientes/lista',
    requiredPermission: 'comanda.clientes.ver',
    subItems: [
      { slug: 'lista',     label: 'Lista de clientes',  href: '/clientes/lista',     badge: 'soon' },
      { slug: 'historial', label: 'Historial pedidos',  href: '/clientes/historial', badge: 'soon' },
      { slug: 'resenas',   label: 'Reseñas',            href: '/clientes/resenas' },
    ],
  },
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
      { slug: 'afip',           label: 'Factura electrónica AFIP', href: '/configuracion/afip' },
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
