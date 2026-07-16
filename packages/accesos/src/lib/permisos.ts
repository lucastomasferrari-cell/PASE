// Catálogo de permisos administrativos del ecosistema (los que controla PASE).
// Sincronizado 1:1 con packages/pase/src/lib/auth.ts (MODULOS + PERMISOS_EXTRAS),
// que es la fuente de verdad: son los mismos slugs que PASE guarda en
// `usuario_permisos` / `rol_permisos` y chequea la RPC `auth_tiene_permiso()`.
//
// IMPORTANTE: acá van SOLO los permisos administrativos (login web → PASE).
// Los permisos operativos del POS (COMANDA) viven en otra tabla
// (`rol_pos_permisos`, por `rol_pos`) y son otro mundo — no se mezclan.
// 'tenants' se omite: es solo superadmin.

export interface PermisoDef {
  slug: string;
  label: string;
  descripcion?: string;
  /**
   * True cuando la feature todavía no está implementada (stub o placeholder).
   * La UI marca el item con ícono de llave (Wrench) y color amarillo/warning
   * para que el dueño sepa que activar ese permiso no tiene efecto real hoy.
   * Referencia: auditoría 17-jul (permisos vs rutas/StubRoute en COMANDA).
   */
  enDesarrollo?: boolean;
}

export interface CategoriaPermisos {
  titulo: string;
  emoji: string;
  permisos: PermisoDef[];
  /** COMANDA: permiso de acceso a la sección (categoría del sidebar). Si el
   * grupo tiene ≥1 sub-item activo, se agrega automáticamente al guardar para
   * que la sección sea visible. Las secciones de PASE no lo usan. */
  seccionSlug?: string;
}

export const CATEGORIAS: CategoriaPermisos[] = [
  {
    titulo: 'Operación diaria', emoji: '',
    permisos: [
      { slug: 'caja', label: 'Caja', descripcion: 'Ver y operar la caja / tesorería.' },
      { slug: 'ventas', label: 'Ventas', descripcion: 'Cargar y ver cierres de ventas.' },
      { slug: 'compras', label: 'Compras', descripcion: 'Cargar/pagar facturas y remitos.' },
      { slug: 'cmv', label: 'Prime Cost', descripcion: 'CMV + costo laboral: prime cost por mes con drill-down a compras y sueldos.' },
      { slug: 'remitos', label: 'Remitos', descripcion: 'Gestionar remitos.' },
      { slug: 'gastos', label: 'Gastos', descripcion: 'Cargar gastos sin factura.' },
      { slug: 'proveedores', label: 'Proveedores', descripcion: 'ABM de proveedores.' },
      { slug: 'mp', label: 'Conciliación MP', descripcion: 'Ver la conciliación de Mercado Pago.' },
      { slug: 'conciliacion', label: 'Conciliación', descripcion: 'Cierre de mes contra extracto. Sensible: crea/anula movimientos según el cruce.' },
    ],
  },
  {
    titulo: 'Reportes y finanzas', emoji: '',
    permisos: [
      { slug: 'negocio', label: 'Negocio' },
      { slug: 'finanzas', label: 'Finanzas' },
      { slug: 'eerr', label: 'Reportes (EERR)' },
      { slug: 'rentabilidad', label: 'Rentabilidad', descripcion: 'Stock valorizado, CMV teórico vs real, simulador.' },
      { slug: 'objetivos', label: 'Objetivos' },
      { slug: 'cashflow', label: 'Cashflow', descripcion: 'La ruta del dinero (base percibida). Sensible.' },
      { slug: 'utilidades', label: 'Utilidades (reparto socios)', descripcion: 'Reparto entre socios. Sensible.' },
      { slug: 'contador', label: 'Contador / IVA' },
      { slug: 'ventas_historico', label: 'Ver histórico de ventas', descripcion: 'Sin esto, solo ve el cierre que cargó en su sesión.' },
    ],
  },
  {
    titulo: 'Equipo (RRHH)', emoji: '',
    permisos: [
      { slug: 'rrhh', label: 'Equipo / RRHH', descripcion: 'Sueldos, adelantos, vacaciones, legajos.' },
      { slug: 'rrhh_liquidacion_final', label: 'Liquidación final (despidos/renuncias)', descripcion: 'Indemnización, SAC, vacaciones. Plata sensible; por default solo dueño/admin.' },
    ],
  },
  {
    titulo: 'Acciones sensibles (anular)', emoji: '',
    permisos: [
      { slug: 'caja_anular', label: 'Anular movimientos de caja', descripcion: 'Sin esto, solo ve/edita; anular bloqueado.' },
      { slug: 'compras_anular', label: 'Anular facturas/remitos', descripcion: 'Sin esto, Compras es solo carga/lectura.' },
      { slug: 'ventas_anular', label: 'Anular ventas/cierres', descripcion: 'Sin esto, crea cierres pero no los revierte.' },
      { slug: 'ver_anulados', label: 'Ver anulados / inactivos', descripcion: 'Habilita los toggles "ver anulados/inactivos" en Caja, Proveedores y RRHH.' },
    ],
  },
  {
    titulo: 'Herramientas', emoji: '',
    permisos: [
      { slug: 'mensajeria', label: 'Mensajería', descripcion: 'Panel del bot de Instagram + responder como humano.' },
      { slug: 'diagnostico_ia', label: 'Asistente de diagnóstico IA', descripcion: 'Modo diagnóstico del bot de ayuda: mira la base (solo lectura) acotado a sus locales.' },
    ],
  },
  {
    titulo: 'Configuración y sistema', emoji: '',
    permisos: [
      { slug: 'ajustes', label: 'Ajustes generales' },
      { slug: 'blindaje', label: 'Blindaje (cierres y bloqueos de mes)' },
      { slug: 'usuarios', label: 'Usuarios y permisos' },
    ],
  },
];

export const TODOS_LOS_PERMISOS: PermisoDef[] = CATEGORIAS.flatMap((c) => c.permisos);

export function permisoDef(slug: string): PermisoDef | null {
  return TODOS_LOS_PERMISOS.find((p) => p.slug === slug) ?? null;
}
