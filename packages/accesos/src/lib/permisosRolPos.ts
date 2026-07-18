// Catálogo de permisos de los roles del POS (PIN): cajero / bartender /
// encargado / manager / dueño. Es lo que puede hacer un empleado que entra con
// PIN en el terminal. Se guarda en `rol_pos_permisos` (global) vía la RPC
// fn_set_rol_pos_permisos. Enfocado en la operación del POS (no el admin, que
// se maneja con las cuentas de mail en la ficha de Personas).

import type { CategoriaPermisos } from './permisos';

export const ROLES_POS = ['cajero', 'bartender', 'encargado', 'manager', 'dueno'] as const;
export type RolPos = (typeof ROLES_POS)[number];

export const ROL_POS_LABEL: Record<RolPos, string> = {
  cajero: 'Cajero',
  bartender: 'Bartender',
  encargado: 'Encargado',
  manager: 'Manager',
  dueno: 'Dueño',
};

export const CATEGORIAS_ROL_POS: CategoriaPermisos[] = [
  {
    titulo: 'Ventas y cobro', emoji: '',
    permisos: [
      { slug: 'comanda.ventas.cobrar', label: 'Tomar pedidos y cobrar' },
      { slug: 'comanda.ventas.descuento', label: 'Hacer descuentos' },
      { slug: 'comanda.ventas.anular', label: 'Anular item / venta' },
      { slug: 'comanda.ventas.refund', label: 'Reembolsar venta', descripcion: 'Devuelve plata — dárselo con cuidado.' },
      { slug: 'comanda.ventas.reopen', label: 'Reabrir venta cobrada' },
      { slug: 'comanda.mesas.gestionar', label: 'Transferir / unir / partir mesas' },
    ],
  },
  {
    titulo: 'Caja y turno', emoji: '',
    permisos: [
      { slug: 'comanda.caja.abrir', label: 'Abrir turno' },
      { slug: 'comanda.caja.cerrar', label: 'Cerrar turno' },
      { slug: 'comanda.caja.movimientos', label: 'Retiros / depósitos / ajustes' },
      { slug: 'comanda.caja.ver_esperado_cierre', label: 'Ver esperado del cierre' },
    ],
  },
  {
    titulo: 'Salón', emoji: '',
    permisos: [
      { slug: 'comanda.salon.editar', label: 'Gestionar salón y mesas' },
    ],
  },
  {
    titulo: 'Ver / consultar', emoji: '',
    permisos: [
      { slug: 'comanda.catalogo.ver', label: 'Ver menú' },
      { slug: 'comanda.reportes.ver', label: 'Ver reportes' },
      { slug: 'comanda.pagos.ver', label: 'Ver métodos de cobro' },
      { slug: 'comanda.empleados.ver', label: 'Ver equipo del turno' },
      { slug: 'comanda.clientes.ver', label: 'Ver clientes' },
    ],
  },
  {
    titulo: 'Editar / gestión', emoji: '',
    permisos: [
      { slug: 'comanda.catalogo.editar', label: 'Editar menú' },
      { slug: 'comanda.catalogo.maestro.importar', label: 'Importar Menú Marca a su local', descripcion: 'Ve el menú de la marca y lo importa a su sucursal. NO edita el maestro.' },
      { slug: 'comanda.pagos.editar', label: 'Editar métodos de cobro' },
      { slug: 'comanda.empleados.editar_pos', label: 'Setear PIN / rol de empleados' },
      { slug: 'comanda.clientes.editar', label: 'Editar clientes' },
      { slug: 'comanda.tienda.aprobar', label: 'Aprobar pedidos online' },
      { slug: 'comanda.audit.ver', label: 'Ver auditoría de overrides' },
      { slug: 'comanda.config.editar', label: 'Editar config del local' },
    ],
  },
];

export const TODOS_SLUGS_ROL_POS = CATEGORIAS_ROL_POS.flatMap((c) => c.permisos.map((p) => p.slug));
