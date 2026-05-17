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
  /** Roles que pueden tener este widget en su dashboard */
  rolesPermitidos: RolPase[];
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
export const DEFAULT_WIDGETS_POR_ROL: Record<RolPase, string[]> = {
  superadmin: ["alertas_sistema", "tareas_pineadas"],
  dueno: [
    "alertas_prioritarias",
    "tareas_pineadas",
    "facturas_vencidas",
    "logbook_resumen",
  ],
  admin: [
    "alertas_prioritarias",
    "tareas_pineadas",
    "facturas_vencidas",
    "logbook_resumen",
  ],
  encargado: [
    "ventas_hoy",
    "mesas_activas",
    "tareas_pineadas",
    "logbook_resumen",
  ],
  compras: [
    "facturas_vencidas",
    "facturas_por_vencer",
    "top_proveedores_mes",
    "tareas_pineadas",
  ],
  cajero: [
    "saldo_caja",
    "ventas_hoy",
    "tareas_pineadas",
  ],
};
