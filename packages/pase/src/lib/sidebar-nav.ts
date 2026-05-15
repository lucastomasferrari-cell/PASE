// ─────────────────────────────────────────────────────────────────────
// Sidebar — definición centralizada (sprint mayo 2026 v2).
//
// 13 items en 4 secciones:
//   • Operación   — Caja, Compras, Ventas, Gastos
//   • Dirección   — Negocio, Finanzas, Objetivos, Reportes
//   • Herramientas— Equipo, Contador / IVA, Blindaje
//   • Sistema     — Ajustes, Usuarios, Tenants
//
// La sección "Módulos" se eliminó (2026-05-14): Equipo se movió a
// Herramientas. La página "Configuración" (antes "Catálogos" / "Sucursales"
// / "Locales") se eliminó del producto — el contenido ya estaba duplicado
// en Ajustes, que ganó como interfaz definitiva.
//
// `tenants` es exclusivo de superadmin — `getPermisos()` lo filtra para
// dueño/admin/encargado, por lo que sólo aparece en el sidebar cuando
// user.rol === "superadmin". Se mantiene en el array para que la lista
// sea completa.
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

export type SidebarSection = "Operación" | "Dirección" | "Herramientas" | "Sistema";

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
  { path: "/gastos",                     slug: "gastos",        label: "Gastos",          sec: "Operación" },

  // === Dirección ===
  { path: "/negocio",                    slug: "negocio",       label: "Negocio",         sec: "Dirección" },
  { path: "/finanzas",                   slug: "finanzas",      label: "Finanzas",        sec: "Dirección" },
  { path: "/objetivos",                  slug: "objetivos",     label: "Objetivos",       sec: "Dirección" },
  { path: "/reportes",                   slug: "eerr",          label: "Reportes",        sec: "Dirección" },

  // === Herramientas ===
  { path: "/equipo",                     slug: "rrhh",          label: "Equipo",          sec: "Herramientas" },
  { path: "/herramientas/contador-iva",  slug: "contador",      label: "Contador / IVA",  sec: "Herramientas" },
  { path: "/herramientas/blindaje",      slug: "blindaje",      label: "Blindaje",        sec: "Herramientas" },
  // Observatorios temporales (2026-05-14) — 2 pruebas paralelas de conciliación.
  // Eliminar cuando se decida el experimento.
  { path: "/herramientas/prueba-conciliacion-1", slug: "prueba_conciliacion_1", label: "Prueba Conciliación 1", sec: "Herramientas" },
  { path: "/herramientas/prueba-conciliacion-2", slug: "prueba_conciliacion_2", label: "Prueba Conciliación 2", sec: "Herramientas" },

  // === Sistema ===
  { path: "/ajustes",                    slug: "ajustes",       label: "Ajustes",         sec: "Sistema" },
  { path: "/usuarios",                   slug: "usuarios",      label: "Usuarios",        sec: "Sistema" },
  { path: "/tenants",                    slug: "tenants",       label: "Tenants",         sec: "Sistema" },
];

export const SIDEBAR_SECTIONS: SidebarSection[] = ["Operación", "Dirección", "Herramientas", "Sistema"];

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
  "/locales":         "/ajustes",
  "/sucursales":      "/ajustes",
  "/catalogos":       "/ajustes",
  "/proveedores":     "/compras/proveedores",
  "/conciliacion-mp": "/caja/conciliacion",
  "/conciliacion":    "/caja/conciliacion",
  "/blindaje":        "/herramientas/blindaje",
  "/contador-iva":    "/herramientas/contador-iva",
  "/contador":        "/herramientas/contador-iva",
};
