// ─────────────────────────────────────────────────────────────────────
// Sidebar — definición centralizada (2026-05-13).
//
// Cambio del sprint mayo 2026: sidebar consolidado a 10 items en
// 4 secciones. Eliminó "Inicio" (Dashboard) y "Movimientos" (placeholder).
//
// Esta es la fuente de verdad para:
//   - Layout.tsx (renderiza el sidebar con SVGs inline; ese array tiene
//     que MANTENERSE alineado con SIDEBAR_ITEMS — mismos slugs/labels/secs).
//   - getDefaultRoute(user): devuelve el slug del primer item al que el
//     user tiene permiso, recorriendo de arriba hacia abajo.
//   - Decidir post-login y root path redirect.
//
// Cuando se conecte un sistema de permisos por slug:requiresPermission,
// reemplazar el simple `tienePermiso` por la lectura de permission flags.
// ─────────────────────────────────────────────────────────────────────

import type { Usuario } from "../types/auth";
import { tienePermiso } from "./auth";

export type SidebarSection = "Operación" | "Dirección" | "Módulos" | "Sistema";

export interface SidebarItem {
  /** Slug interno (matchea con section state de App.tsx y con el slug en auth.ts) */
  slug: string;
  /** Label visible en el sidebar */
  label: string;
  /** Sección a la que pertenece */
  sec: SidebarSection;
}

/**
 * Orden canónico de items del sidebar. Cualquier cambio de orden o de
 * mapeo slug↔sección impacta directamente en getDefaultRoute, así que
 * tocar acá con cuidado.
 */
export const SIDEBAR_ITEMS: SidebarItem[] = [
  // === Operación (3) ===
  { slug: "caja",          label: "Caja",      sec: "Operación" },
  { slug: "compras",       label: "Compras",   sec: "Operación" },
  { slug: "ventas",        label: "Ventas",    sec: "Operación" },

  // === Dirección (4) ===
  { slug: "negocio",       label: "Negocio",   sec: "Dirección" },
  { slug: "finanzas",      label: "Finanzas",  sec: "Dirección" },
  { slug: "objetivos",     label: "Objetivos", sec: "Dirección" },
  { slug: "eerr",          label: "Reportes",  sec: "Dirección" },

  // === Módulos (2) ===
  // 'Equipo' apunta al slug `rrhh` (la lista del equipo en RRHHPage).
  // El label visible es 'Equipo' por brief 2026-05-13.
  { slug: "rrhh",          label: "Equipo",    sec: "Módulos" },
  { slug: "configuracion", label: "Locales",   sec: "Módulos" },

  // === Sistema (1) ===
  { slug: "ajustes",       label: "Ajustes",   sec: "Sistema" },
];

export const SIDEBAR_SECTIONS: SidebarSection[] = ["Operación", "Dirección", "Módulos", "Sistema"];

/**
 * Devuelve el slug del primer item del sidebar al que el user tiene
 * permiso, recorriendo SIDEBAR_ITEMS de arriba hacia abajo.
 *
 * Si el user no tiene permiso a NINGÚN item (caso edge), devuelve
 * `'ajustes'` como fallback porque es la sección Sistema y dueño/admin
 * siempre la ve.
 */
export function getDefaultRoute(user: Usuario | null | undefined): string {
  if (!user) return "ajustes";
  const first = SIDEBAR_ITEMS.find(item => tienePermiso(user, item.slug));
  return first?.slug ?? "ajustes";
}

/** Slugs eliminados del producto. Al detectarlos en sessionStorage o en el state,
 * redirigir transparentemente a getDefaultRoute(). */
export const DEPRECATED_SLUGS = new Set([
  "dashboard",   // pantalla "Inicio" eliminada 2026-05-13
  "movimientos", // placeholder eliminado 2026-05-13
  "cashflow",    // eliminado 2026-05-11
  "cierre",      // fusionado en EERR 2026-05-08
]);
