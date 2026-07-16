// Catálogo de permisos de COMANDA para Accesos. Dos tipos:
//   - NAVEGACIÓN (comanda.nav.<cat>.<sub>): acceso a cada sub-pantalla del
//     sidebar. Espejo de adminNavigation de COMANDA (que estampa esos slugs y
//     los usa para ocultar/bloquear la ruta). `seccionSlug` = permiso de
//     acceso a la sección; se agrega solo al guardar si hay ≥1 sub activo.
//   - ACCIÓN (comanda.*): permisos funcionales del POS/catálogo (cobrar,
//     editar, anular…). Espejo de SLUGS_COMANDA (acciones) de permisosService.
//
// Se guardan en usuarios.accesos_por_app.comanda.permisos y el enganche
// (fn_sincronizar_comanda_acceso) los espeja a comanda_usuario_permisos.

import type { CategoriaPermisos } from './permisos';

// Tercer elemento opcional en la tupla: true si la feature no está terminada.
type NavItem = [slug: string, label: string, enDesarrollo?: boolean];
function navSec(titulo: string, cat: string, seccionSlug: string, items: NavItem[]): CategoriaPermisos {
  return {
    titulo, emoji: '', seccionSlug,
    permisos: items.map(([s, label, enDesarrollo]) => ({
      slug: `comanda.nav.${cat}.${s}`, label,
      ...(enDesarrollo ? { enDesarrollo: true } : {}),
    })),
  };
}

// Auditoría 17-jul (Lucas): reorganización de categorías para eliminar
// nombres duplicados y agrupar por dominio real. Slugs NO cambian —
// solo se renombran los labels/títulos y se reagrupa la sección Acciones
// (que antes mezclaba 20 permisos POS+admin).
export const CATEGORIAS_COMANDA: CategoriaPermisos[] = [
  navSec('Reportes', 'reportes', 'comanda.reportes.ver', [
    ['dashboard', 'Dashboard'],
    ['menu-engineering', 'Menu Engineering'],
    ['cmv', 'CMV (costo mercadería)'],
    ['ventas', 'Ventas (detalle)'],
    ['productos', 'Productos'],
    // Renombrado 17-jul: "Canales" pisaba el sub-item homónimo de Menú.
    ['canales', 'Reporte por canal'],
    ['empleados', 'Performance de empleados'],
    ['tiempos', 'Tiempos'],
    ['auditoria', 'Auditoría'],
  ]),
  navSec('Menú', 'menu', 'comanda.catalogo.ver', [
    ['items', 'Items'],
    ['grupos', 'Grupos'],
    ['modificadores', 'Modificadores'],
    // App.tsx:286 apunta /menu/combos a StubRoute — pantalla no implementada.
    ['combos', 'Combos', true],
    ['canales', 'Canales de venta'],
    ['lista-precios', 'Lista de precios'],
    ['disponibilidad', 'Disponibilidad'],
    ['alertas-margen', 'Alertas de margen'],
    ['revision', 'Items por revisar'],
  ]),
  // Slug propio 17-jul: antes compartía 'comanda.catalogo.ver' con Menú y
  // dar uno abría también el otro. Migración 202607170300 hace backfill —
  // quien tenía catalogo.ver ya tiene inventario.ver, no pierde acceso.
  navSec('Inventario', 'inventario', 'comanda.inventario.ver', [
    ['alertas', 'Stock + alertas'],
    ['mermas', 'Cargar merma'],
    ['conteo', 'Conteo físico'],
    ['transferencias', 'Transferencias entre locales'],
  ]),
  navSec('Salón', 'salon', 'comanda.salon.editar', [
    ['mesas', 'Mesas'],
    // Reservas eliminadas 17-jul: la feature vive en MESA (mesa-orpin).
    ['servicios', 'Servicios y turnos', true],
  ]),
  // Renombrado 17-jul: "Turno" no describía el contenido (mi cierre,
  // propinas, quién trabaja).
  navSec('Personal', 'empleados', 'comanda.empleados.ver', [
    ['mi-cierre', 'Mi cierre del día'],
    ['propinas', 'Reparto de propinas'],
    ['horarios', 'Trabajando ahora'],
    ['performance', 'Performance', true],
  ]),
  navSec('Pagos y caja', 'pagos', 'comanda.pagos.ver', [
    ['metodos', 'Métodos de cobro'],
    ['logbook', 'Logbook'],
    ['caja-chica', 'Caja chica', true],
    ['historico-turnos', 'Histórico de turnos', true],
    ['conciliacion-mp', 'Conciliación MP', true],
    ['settlements', 'Settlements', true],
  ]),
  // Renombrado 17-jul: "Tienda online" y "Online" (abajo) eran casi
  // idénticos. Esta es la tienda propia con marketplace/difusión; la
  // otra sección es canales digitales (QR, KDS, delivery).
  // Slug propio 17-jul: antes compartía 'comanda.online.gestionar' con
  // "Canales digitales" y dar uno abría también el otro. Migración
  // 202607170300 hace backfill — no perdiste acceso si tenías el viejo.
  navSec('Tienda propia', 'tienda-online', 'comanda.tienda.gestionar', [
    ['resumen', 'Resumen'],
    // Renombrado: "Configuración" pisaba el nombre de la sección top-level.
    ['configuracion', 'Ajustes de tienda'],
    ['difusion', 'Difusión'],
  ]),
  navSec('Canales digitales', 'online', 'comanda.online.gestionar', [
    ['menu-qr', 'Menú QR'],
    ['kds', 'KDS (pantalla de cocina)'],
    ['dispatch', 'Despacho de delivery'],
    ['tracking', 'Tracking pedidos', true],
  ]),
  navSec('Hardware', 'hardware', 'comanda.hardware.gestionar', [
    ['estaciones', 'Estaciones'],
    ['impresoras', 'Impresoras'],
    ['agentes', 'Print Agents (PCs)'],
    ['riders', 'Repartidores'],
    ['cajon', 'Cajón de dinero', true],
    ['mp-point', 'MP Point', true],
    ['tablets-kds', 'Tablets KDS', true],
  ]),
  // "Integraciones" ambigua se resolvió: acá es solo plataformas de
  // delivery. Las notificaciones (WhatsApp/Email) están en Configuración
  // como "Notificaciones".
  navSec('Integraciones (delivery)', 'integraciones', 'comanda.integraciones.gestionar', [
    ['mercadopago', 'Mercado Pago', true],
    ['rappi', 'Rappi'],
    ['pedidosya', 'PedidosYa'],
    // Deliverect eliminado 17-jul.
    ['whatsapp', 'WhatsApp Business', true],
    ['contabilidad', 'Contabilidad', true],
    ['api', 'Webhooks / API', true],
  ]),
  navSec('Configuración', 'configuracion', 'comanda.configuracion.editar', [
    ['local', 'Local'],
    ['cubiertos', 'Cubierto por sector'],
    // Renombrado 17-jul: "Integraciones" chocaba con la sección top-level.
    ['integraciones', 'Notificaciones (WhatsApp, Email…)'],
    ['afip', 'Factura electrónica AFIP'],
    ['afip-pendientes', 'AFIP pendientes'],
    ['branding', 'Branding y logos', true],
    ['notificaciones', 'Notificaciones', true],
    ['recibos', 'Recibos e impresión', true],
    ['idioma', 'Idioma y zona horaria', true],
    ['backup', 'Backup y exportación', true],
  ]),
  // Sección nueva 17-jul: Suscripción del dueño (plan, facturación,
  // métodos de pago propios). Todos stubs — cuando SaaS se comercialice.
  navSec('Suscripción', 'suscripcion', 'comanda.configuracion.editar', [
    ['plan', 'Plan actual', true],
    ['facturacion', 'Facturación', true],
    ['metodos-pago', 'Métodos de pago', true],
    ['historial', 'Historial de pagos', true],
  ]),
  // Auditoría 17-jul: la sección monolítica "Acciones (POS y catálogo)"
  // (20 permisos) se dividió en dos por dominio de uso — POS diario vs
  // administración de catálogo/config. Los slugs NO cambian.
  {
    titulo: 'Acciones POS (operación diaria)', emoji: '',
    permisos: [
      { slug: 'comanda.ventas.cobrar', label: 'Tomar pedidos y cobrar' },
      { slug: 'comanda.ventas.anular', label: 'Anular item / venta', descripcion: 'Con override de manager.' },
      { slug: 'comanda.ventas.descuento', label: 'Descuentos sin manager' },
      { slug: 'comanda.ventas.refund', label: 'Reembolsar venta cobrada' },
      { slug: 'comanda.ventas.reopen', label: 'Reabrir venta cobrada' },
      { slug: 'comanda.mesas.gestionar', label: 'Transferir / unir / partir mesas' },
      { slug: 'comanda.caja.abrir', label: 'Abrir turno' },
      { slug: 'comanda.caja.cerrar', label: 'Cerrar turno' },
      { slug: 'comanda.caja.movimientos', label: 'Retiros / depósitos / ajustes' },
      { slug: 'comanda.tienda.aprobar', label: 'Aprobar pedidos online' },
    ],
  },
  {
    titulo: 'Acciones Admin (catálogo, config)', emoji: '',
    permisos: [
      { slug: 'comanda.catalogo.editar', label: 'Editar items y grupos' },
      { slug: 'comanda.catalogo.eliminar', label: 'Eliminar items' },
      { slug: 'comanda.canales.editar', label: 'Editar canales' },
      { slug: 'comanda.precios.editar', label: 'Editar precios' },
      { slug: 'comanda.precios.aumento_masivo', label: 'Aumento masivo de precios' },
      { slug: 'comanda.modifiers.editar', label: 'Editar modificadores' },
      { slug: 'comanda.tax.editar', label: 'Editar impuestos' },
      { slug: 'comanda.empleados.editar_pos', label: 'Setear PIN / rol POS de empleados' },
      { slug: 'comanda.config.editar', label: 'Editar config del local' },
      { slug: 'comanda.audit.ver', label: 'Ver auditoría de overrides' },
    ],
  },
];

// Al guardar: si un grupo de sección tiene ≥1 sub-item activo, agregar su
// seccionSlug (acceso a la sección) para que la sección sea visible en COMANDA.
export function normalizarPermisosComanda(perms: string[]): string[] {
  const set = new Set(perms);
  for (const g of CATEGORIAS_COMANDA) {
    if (g.seccionSlug && g.permisos.some((p) => set.has(p.slug))) set.add(g.seccionSlug);
  }
  return [...set];
}
