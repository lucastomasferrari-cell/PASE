// ─────────────────────────────────────────────────────────────────────
// Sidebar — definición centralizada (sprint mayo 2026 v2).
//
// 10 items en 5 secciones (post Commit 3 del sprint v2):
//   • Operación   — Caja, Compras, Ventas
//   • Dirección   — Negocio, Finanzas, Objetivos, Reportes
//   • Módulos     — Equipo, Sucursales
//   • Herramientas— Contador / IVA, Blindaje
//   • Sistema     — Ajustes
//
// Cada item tiene:
//   - path: URL real (post Commit 1 v2 — React Router)
//   - slug: usado por tienePermiso() (mantiene compat con sistema de permisos
//     actual basado en slugs).
//   - label: visible en sidebar.
//   - sec: sección a la que pertenece.
// ─────────────────────────────────────────────────────────────────────

import type { Usuario } from "../types/auth";
import { tienePermiso } from "./auth";

export type SidebarSection = "Operación" | "Dirección" | "Módulos" | "Herramientas" | "Sistema";

export interface SidebarItem {
  /** URL canónica del módulo */
  path: string;
  /** Slug interno (compat con auth.ts MODULOS y tienePermiso) */
  slug: string;
  /** Texto visible */
  label: string;
  /** Sección */
  sec: SidebarSection;
}

export const SIDEBAR_ITEMS: SidebarItem[] = [
  // === Operación ===
  { path: "/caja",                       slug: "caja",          label: "Caja",            sec: "Operación" },
  { path: "/compras",                    slug: "compras",       label: "Compras",         sec: "Operación" },
  { path: "/ventas",                     slug: "ventas",        label: "Ventas",          sec: "Operación" },

  // === Dirección ===
  { path: "/negocio",                    slug: "negocio",       label: "Negocio",         sec: "Dirección" },
  { path: "/finanzas",                   slug: "finanzas",      label: "Finanzas",        sec: "Dirección" },
  { path: "/objetivos",                  slug: "objetivos",     label: "Objetivos",       sec: "Dirección" },
  { path: "/reportes",                   slug: "eerr",          label: "Reportes",        sec: "Dirección" },

  // === Módulos ===
  { path: "/equipo",                     slug: "rrhh",          label: "Equipo",          sec: "Módulos" },
  { path: "/sucursales",                 slug: "configuracion", label: "Sucursales",      sec: "Módulos" },

  // === Herramientas ===
  { path: "/herramientas/contador-iva",  slug: "contador",      label: "Contador / IVA",  sec: "Herramientas" },
  { path: "/herramientas/blindaje",      slug: "blindaje",      label: "Blindaje",        sec: "Herramientas" },

  // === Sistema ===
  { path: "/ajustes",                    slug: "ajustes",       label: "Ajustes",         sec: "Sistema" },
];

export const SIDEBAR_SECTIONS: SidebarSection[] = ["Operación", "Dirección", "Módulos", "Herramientas", "Sistema"];

/**
 * Devuelve el PATH del primer item del sidebar al que el user tiene
 * permiso. Usado en redirect del root path `/` y post-login.
 *
 * Fallback a "/ajustes" si no tiene permiso a ningún item.
 */
export function getDefaultRoute(user: Usuario | null | undefined): string {
  if (!user) return "/ajustes";
  const first = SIDEBAR_ITEMS.find(item => tienePermiso(user, item.slug));
  return first?.path ?? "/ajustes";
}

/**
 * Mapa de URL legacy → URL nueva. Usado por <Navigate> redirects.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  "/inicio":          "@default",  // sentinel: resolver a getDefaultRoute()
  "/dashboard":       "@default",
  "/movimientos":     "/caja/movimientos",
  "/rrhh":            "/equipo",
  "/locales":         "/sucursales",
  "/proveedores":     "/compras/proveedores",
  "/conciliacion-mp": "/caja/conciliacion",
  "/conciliacion":    "/caja/conciliacion",
  "/blindaje":        "/herramientas/blindaje",
  "/contador-iva":    "/herramientas/contador-iva",
  "/contador":        "/herramientas/contador-iva",
};
