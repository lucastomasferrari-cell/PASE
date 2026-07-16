// Catálogo de permisos de COMANDA (POS). Espejo de `SLUGS_COMANDA` de
// packages/comanda/src/services/permisosService.ts, que es la fuente de verdad:
// son los mismos slugs `comanda.*` que COMANDA guarda en
// `comanda_usuario_permisos` y chequea `tienePermiso()`.
//
// El enganche por email (RPC fn_sincronizar_comanda_acceso) sincroniza el
// comanda_usuario + estos permisos cuando se da acceso a COMANDA desde Accesos.
// Agrupado por módulo, igual que el catálogo de PASE (misma forma que permisos.ts).

import type { CategoriaPermisos } from './permisos';

export const CATEGORIAS_COMANDA: CategoriaPermisos[] = [
  {
    titulo: 'Catálogo / Menú', emoji: '',
    permisos: [
      { slug: 'comanda.catalogo.ver', label: 'Ver catálogo', descripcion: 'Ver items y grupos del menú.' },
      { slug: 'comanda.catalogo.editar', label: 'Editar items y grupos' },
      { slug: 'comanda.catalogo.eliminar', label: 'Eliminar items' },
      { slug: 'comanda.canales.ver', label: 'Ver canales' },
      { slug: 'comanda.canales.editar', label: 'Editar canales' },
      { slug: 'comanda.precios.editar', label: 'Editar precios', descripcion: 'Precio por celda (item × canal).' },
      { slug: 'comanda.precios.aumento_masivo', label: 'Aumento masivo de precios' },
      { slug: 'comanda.modifiers.editar', label: 'Editar modificadores' },
      { slug: 'comanda.tax.editar', label: 'Editar impuestos' },
    ],
  },
  {
    titulo: 'POS (salón / mostrador)', emoji: '',
    permisos: [
      { slug: 'comanda.ventas.cobrar', label: 'Tomar pedidos y cobrar' },
      { slug: 'comanda.ventas.anular', label: 'Anular item / venta', descripcion: 'Con override de manager.' },
      { slug: 'comanda.ventas.descuento', label: 'Descuentos chicos sin manager' },
      { slug: 'comanda.ventas.refund', label: 'Reembolsar venta cobrada' },
      { slug: 'comanda.ventas.reopen', label: 'Reabrir venta cobrada' },
      { slug: 'comanda.mesas.gestionar', label: 'Transferir / unir / partir mesas' },
    ],
  },
  {
    titulo: 'Caja / Turno', emoji: '',
    permisos: [
      { slug: 'comanda.caja.abrir', label: 'Abrir turno' },
      { slug: 'comanda.caja.cerrar', label: 'Cerrar turno' },
      { slug: 'comanda.caja.movimientos', label: 'Retiros / depósitos / ajustes' },
    ],
  },
  {
    titulo: 'Tienda online', emoji: '',
    permisos: [
      { slug: 'comanda.tienda.aprobar', label: 'Aprobar pedidos online' },
    ],
  },
  {
    titulo: 'Configuración', emoji: '',
    permisos: [
      { slug: 'comanda.empleados.editar_pos', label: 'Setear PIN / rol POS de empleados' },
      { slug: 'comanda.config.editar', label: 'Editar config del local' },
      { slug: 'comanda.audit.ver', label: 'Ver auditoría de overrides' },
    ],
  },
];
