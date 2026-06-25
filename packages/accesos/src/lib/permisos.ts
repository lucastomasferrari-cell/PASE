// Catálogo de permisos del ecosistema. Lo usa Accesos para mostrar la matriz
// de Roles y permisos. Los slugs son los mismos que usa PASE en la columna
// `usuarios.permisos` y en la RPC `auth_tiene_permiso()` — porteado de
// packages/pase/src/lib/auth.ts.PERMISOS_EXTRAS.

export interface PermisoDef {
  slug: string;
  label: string;
  descripcion?: string;
  app: 'pase' | 'comanda' | 'mesa' | 'habitue' | 'cross';
}

export interface CategoriaPermisos {
  titulo: string;
  emoji: string;
  permisos: PermisoDef[];
}

export const CATEGORIAS: CategoriaPermisos[] = [
  {
    titulo: 'Operación diaria (PASE)', emoji: '💸',
    permisos: [
      { slug: 'caja', label: 'Caja y movimientos', descripcion: 'Ver y operar la caja.', app: 'pase' },
      { slug: 'ventas', label: 'Ventas', descripcion: 'Cargar y ver ventas.', app: 'pase' },
      { slug: 'compras', label: 'Compras', descripcion: 'Cargar/pagar facturas y remitos.', app: 'pase' },
      { slug: 'remitos', label: 'Remitos', descripcion: 'Gestionar remitos.', app: 'pase' },
      { slug: 'gastos', label: 'Gastos', descripcion: 'Cargar gastos sin factura.', app: 'pase' },
      { slug: 'proveedores', label: 'Proveedores', descripcion: 'ABM de proveedores.', app: 'pase' },
    ],
  },
  {
    titulo: 'Gestión y reportes (PASE)', emoji: '📊',
    permisos: [
      { slug: 'negocio', label: 'Panel del negocio', app: 'pase' },
      { slug: 'finanzas', label: 'Finanzas', app: 'pase' },
      { slug: 'eerr', label: 'Estado de resultados (EERR)', app: 'pase' },
      { slug: 'rentabilidad', label: 'Rentabilidad', app: 'pase' },
      { slug: 'objetivos', label: 'Objetivos', app: 'pase' },
      { slug: 'rrhh', label: 'RRHH (sueldos, adelantos, vacaciones)', app: 'pase' },
      { slug: 'mensajeria', label: 'Mensajería interna', app: 'pase' },
    ],
  },
  {
    titulo: 'Acciones destructivas (sin permiso pide código del dueño)', emoji: '🛡️',
    permisos: [
      { slug: 'caja_anular', label: 'Anular movimientos de caja', app: 'pase' },
      { slug: 'compras_anular', label: 'Anular facturas/remitos', app: 'pase' },
      { slug: 'ventas_anular', label: 'Anular ventas', app: 'pase' },
      { slug: 'rrhh_anular', label: 'Anular pagos de RRHH', app: 'pase' },
    ],
  },
  {
    titulo: 'Configuración (PASE)', emoji: '⚙️',
    permisos: [
      { slug: 'ajustes', label: 'Ajustes generales', app: 'pase' },
      { slug: 'blindaje', label: 'Blindaje (cierres y bloqueos)', app: 'pase' },
    ],
  },
  {
    titulo: 'COMANDA — POS y catálogo', emoji: '📱',
    permisos: [
      { slug: 'comanda.salon.editar', label: 'Editar salón/mesas', app: 'comanda' },
      { slug: 'comanda.config.editar', label: 'Configuración de COMANDA', app: 'comanda' },
      { slug: 'comanda.empleados.ver', label: 'Ver empleados POS', app: 'comanda' },
    ],
  },
  {
    titulo: 'MESA — reservas', emoji: '🗺️',
    permisos: [
      { slug: 'mesa.reservas.editar', label: 'Crear/editar reservas', app: 'mesa' },
      { slug: 'mesa.config.editar', label: 'Configurar horarios y mesas', app: 'mesa' },
    ],
  },
  {
    titulo: 'Habitué — CRM y marketing', emoji: '💛',
    permisos: [
      { slug: 'habitue.campanas.enviar', label: 'Enviar campañas', app: 'habitue' },
      { slug: 'habitue.cupones.editar', label: 'Crear cupones y vouchers', app: 'habitue' },
      { slug: 'habitue.config.editar', label: 'Configurar integraciones y fidelidad', app: 'habitue' },
    ],
  },
];

export const TODOS_LOS_PERMISOS: PermisoDef[] = CATEGORIAS.flatMap((c) => c.permisos);

export function permisoDef(slug: string): PermisoDef | null {
  return TODOS_LOS_PERMISOS.find((p) => p.slug === slug) ?? null;
}
