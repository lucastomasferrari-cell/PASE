// Tipos centrales para dashboards personalizados.
//
// Cada widget es un componente con:
//   - id único string (ej. 'saldo_caja', 'facturas_vencidas')
//   - title visible
//   - roles que pueden verlo
//   - render fn que recibe props comunes (usuario, locales, etc.)
//
// El registry vive en widgets/registry.ts y se importa desde DashboardHome.

import type { ReactNode } from "react";

export type RolPase = "dueno" | "admin" | "encargado" | "compras" | "cajero" | "superadmin";

// Tamaño visual del widget. La grilla del dashboard usa esto para layout.
export type WidgetSize = "sm" | "md" | "lg" | "full";
// sm = 1 col (mobile) / 1 col (desktop)
// md = 1 col mobile / 2 cols desktop (estándar)
// lg = 1 col mobile / 3 cols desktop
// full = ancho completo siempre

export interface WidgetContext {
  /** Usuario logueado */
  usuario: {
    id: number;
    nombre: string;
    rol: RolPase;
    tenant_id: string | null;
    /**
     * Restricción de cuentas que el user puede VER el saldo (cards de Caja
     * + widgets de dashboard). null = sin restricción (dueño/admin típico).
     * Se respeta también para widgets del dashboard, no solo en /caja.
     * Bug 24-may: SaldoCajaWidget mostraba TODAS las cuentas sin respetar
     * esto, exponiendo Caja Efectivo a encargados que no la tenían.
     */
    cuentas_visibles: string[] | null;
  };
  /** Locales del tenant que el usuario puede ver */
  locales: Array<{ id: number; nombre: string }>;
  /** Local activo en sesión (puede ser null si dueño ve consolidado) */
  localActivo: number | null;
}

export interface WidgetDefinition {
  /** Identificador único del widget (estable, NO cambiar después de publicar) */
  id: string;
  /** Título visible arriba del widget */
  title: string;
  /** Descripción corta para la UI de Settings ("Saldo de caja efectivo + cuentas") */
  description: string;
  /**
   * Slugs de permiso requeridos (any-of) para ver el widget. Si vacío `[]`,
   * el widget es cross-rol (lo puede ver cualquier usuario autenticado, p.ej.
   * "Tareas y mensajes"). El filtrado real se hace contra `getPermisos(user)`
   * — un dueño/admin/superadmin ve TODOS los widgets sin importar este array.
   *
   * Reemplaza al deprecated `rolesPermitidos`: en 2026-05 todos los usuarios
   * tienen rol nominal "encargado" en la tabla y la diferenciación es por
   * matriz de permisos. Filtrar por rol dejaba a casi todos sin ver nada.
   */
  permisosRequeridos: string[];
  /** Tamaño visual */
  size: WidgetSize;
  /** Componente React que renderiza el widget. Recibe el contexto. */
  render: (ctx: WidgetContext) => ReactNode;
  /** Ícono SVG inline opcional (~14x14) para Settings */
  icon?: ReactNode;
}

// Config de dashboard guardada en DB (tabla usuario_dashboard_config).
export interface DashboardConfig {
  /** IDs de widgets activos en orden visual */
  widgets_activos: string[];
  /** Opciones específicas por widget (JSON arbitrario) */
  widgets_config: Record<string, Record<string, unknown>>;
  /** True si el usuario está en defaults del rol (no fue customizado) */
  es_default: boolean;
}

// Defaults por rol — usados cuando el usuario no tiene config en DB todavía.
// Como ahora los permisos vienen de la matriz (no del rol), estos defaults
// son una sugerencia inicial. El dueño puede customizar widget por widget.
export const DEFAULT_WIDGETS_POR_ROL: Record<RolPase, string[]> = {
  superadmin: ["tareas_pineadas", "ventas_semana", "objetivos_mes"],
  dueno: [
    "tareas_pineadas",
    "ventas_semana",
    "objetivos_mes",
    "punto_equilibrio",
    "comparativa_sucursales",
    "facturas_por_vencer",
    "facturas_vencidas",
    "ultimos_overrides",
  ],
  admin: [
    "tareas_pineadas",
    "ventas_semana",
    "objetivos_mes",
    "punto_equilibrio",
    "facturas_vencidas",
    "ultimos_overrides",
  ],
  encargado: [
    "proximo_paso",
    "tareas_pineadas",
    "ventas_hoy",
    "saldo_caja",
  ],
  compras: [
    "proximo_paso",
    "tareas_pineadas",
    "facturas_vencidas",
    "facturas_por_vencer",
  ],
  cajero: [
    "proximo_paso",
    "tareas_pineadas",
    "saldo_caja",
    "ventas_hoy",
  ],
};
