// Catálogo de permisos POR APP para el acordeón de Personas.
// PASE ya tiene su catálogo (permisos.ts, enforce vía usuario_permisos).
// COMANDA tiene permisos reales (comanda.* — los mismos que chequea su sidebar
// y auth). Se guardan por ahora en usuarios.accesos_por_app.comanda.permisos;
// el enforcement real (sincronizar a comanda_usuario_permisos) llega en la
// Fase 2 (enganche PASE↔COMANDA por email).
// MESA y Habitué todavía NO tienen permisos granulares en sus apps → sin catálogo.

import { CATEGORIAS as PASE_CATEGORIAS, type CategoriaPermisos } from './permisos';

const COMANDA_CATEGORIAS: CategoriaPermisos[] = [
  {
    titulo: 'Reportes y catálogo', emoji: '',
    permisos: [
      { slug: 'comanda.reportes.ver', label: 'Reportes', descripcion: 'Ver dashboards y reportes del POS.' },
      { slug: 'comanda.catalogo.ver', label: 'Menú / catálogo', descripcion: 'Ver y editar items, grupos, modificadores.' },
      { slug: 'comanda.precios.editar', label: 'Editar precios', descripcion: 'Cambiar precios por canal en la lista de precios.' },
      { slug: 'comanda.precios.aumento_masivo', label: 'Aumentos masivos', descripcion: 'Correr aumentos de precio masivos / por canal.' },
    ],
  },
  {
    titulo: 'Operación', emoji: '',
    permisos: [
      { slug: 'comanda.salon.editar', label: 'Salón / mesas', descripcion: 'Configurar el plano del salón y las mesas.' },
      { slug: 'comanda.pagos.ver', label: 'Pagos y caja', descripcion: 'Métodos de cobro, caja, logbook.' },
      { slug: 'comanda.tienda.aprobar', label: 'Aprobar pedidos online', descripcion: 'Aceptar/rechazar pedidos de la tienda antes de cocina.' },
      { slug: 'comanda.online.gestionar', label: 'Tienda online', descripcion: 'Configurar la tienda/marketplace, KDS, delivery.' },
    ],
  },
  {
    titulo: 'Gestión', emoji: '',
    permisos: [
      { slug: 'comanda.empleados.ver', label: 'Turno / empleados', descripcion: 'Cierre de caja, propinas, quién trabaja.' },
      { slug: 'comanda.hardware.gestionar', label: 'Hardware', descripcion: 'Impresoras, estaciones, print agents, riders.' },
      { slug: 'comanda.integraciones.gestionar', label: 'Integraciones', descripcion: 'Rappi, PedidosYa, Deliverect, Mercado Pago.' },
      { slug: 'comanda.configuracion.editar', label: 'Configuración', descripcion: 'Ajustes del local, AFIP, branding.' },
    ],
  },
];

// Devuelve el catálogo de permisos de una app, o null si esa app todavía no
// tiene permisos granulares (MESA, Habitué, Instagram, Accesos).
export function catalogoPermisosApp(appKey: string): CategoriaPermisos[] | null {
  if (appKey === 'pase') return PASE_CATEGORIAS;
  if (appKey === 'comanda') return COMANDA_CATEGORIAS;
  return null;
}
