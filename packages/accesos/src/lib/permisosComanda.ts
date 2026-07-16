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

function navSec(titulo: string, cat: string, seccionSlug: string, items: [string, string][]): CategoriaPermisos {
  return {
    titulo, emoji: '', seccionSlug,
    permisos: items.map(([s, label]) => ({ slug: `comanda.nav.${cat}.${s}`, label })),
  };
}

export const CATEGORIAS_COMANDA: CategoriaPermisos[] = [
  navSec('Reportes', 'reportes', 'comanda.reportes.ver', [
    ['dashboard', 'Dashboard'],
    ['menu-engineering', 'Menu Engineering'],
    ['cmv', 'CMV (costo mercadería)'],
    ['ventas', 'Ventas (detalle)'],
    ['productos', 'Productos'],
    ['canales', 'Canales'],
    ['empleados', 'Performance de empleados'],
    ['tiempos', 'Tiempos'],
    ['auditoria', 'Auditoría'],
  ]),
  navSec('Menú', 'menu', 'comanda.catalogo.ver', [
    ['items', 'Items'],
    ['grupos', 'Grupos'],
    ['modificadores', 'Modificadores'],
    ['combos', 'Combos'],
    ['canales', 'Canales'],
    ['lista-precios', 'Lista de precios'],
    ['disponibilidad', 'Disponibilidad'],
    ['alertas-margen', 'Alertas de margen'],
    ['revision', 'Items por revisar'],
  ]),
  navSec('Inventario', 'inventario', 'comanda.catalogo.ver', [
    ['alertas', 'Stock + alertas'],
    ['mermas', 'Cargar merma'],
    ['conteo', 'Conteo físico'],
    ['transferencias', 'Transferencias entre locales'],
  ]),
  navSec('Salón', 'salon', 'comanda.salon.editar', [
    ['mesas', 'Mesas'],
    ['reservas', 'Reservas'],
  ]),
  navSec('Turno', 'empleados', 'comanda.empleados.ver', [
    ['mi-cierre', 'Mi cierre del día'],
    ['propinas', 'Reparto de propinas'],
    ['horarios', 'Trabajando ahora'],
  ]),
  navSec('Pagos y caja', 'pagos', 'comanda.pagos.ver', [
    ['metodos', 'Métodos de cobro'],
    ['logbook', 'Logbook'],
  ]),
  navSec('Tienda online', 'tienda-online', 'comanda.online.gestionar', [
    ['resumen', 'Resumen'],
    ['configuracion', 'Configuración'],
    ['difusion', 'Difusión'],
  ]),
  navSec('Online', 'online', 'comanda.online.gestionar', [
    ['menu-qr', 'Menú QR'],
    ['kds', 'KDS (pantalla de cocina)'],
    ['dispatch', 'Despacho de delivery'],
  ]),
  navSec('Hardware', 'hardware', 'comanda.hardware.gestionar', [
    ['estaciones', 'Estaciones'],
    ['impresoras', 'Impresoras'],
    ['agentes', 'Print Agents (PCs)'],
    ['riders', 'Repartidores'],
  ]),
  navSec('Integraciones', 'integraciones', 'comanda.integraciones.gestionar', [
    ['rappi', 'Rappi'],
    ['pedidosya', 'PedidosYa'],
    ['deliverect', 'Deliverect'],
  ]),
  navSec('Configuración', 'configuracion', 'comanda.configuracion.editar', [
    ['local', 'Local'],
    ['cubiertos', 'Cubierto por sector'],
    ['integraciones', 'Integraciones (WhatsApp, Email…)'],
    ['afip', 'Factura electrónica AFIP'],
    ['afip-pendientes', 'AFIP pendientes'],
  ]),
  {
    titulo: 'Acciones (POS y catálogo)', emoji: '',
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
      { slug: 'comanda.catalogo.editar', label: 'Editar items y grupos' },
      { slug: 'comanda.catalogo.eliminar', label: 'Eliminar items' },
      { slug: 'comanda.canales.editar', label: 'Editar canales' },
      { slug: 'comanda.precios.editar', label: 'Editar precios' },
      { slug: 'comanda.precios.aumento_masivo', label: 'Aumento masivo de precios' },
      { slug: 'comanda.modifiers.editar', label: 'Editar modificadores' },
      { slug: 'comanda.tax.editar', label: 'Editar impuestos' },
      { slug: 'comanda.tienda.aprobar', label: 'Aprobar pedidos online' },
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
