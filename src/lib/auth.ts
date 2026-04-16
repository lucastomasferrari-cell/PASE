import { createContext, useContext } from "react";

// ─── TIPOS ───────────────────────────────────────────────────────────────────
// usuarios.id = INTEGER, usuarios.rol = TEXT, usuarios.locales = INTEGER[]
// locales.id = INTEGER
// usuario_permisos.usuario_id = INTEGER
// usuario_locales.usuario_id = INTEGER, local_id = INTEGER
// rrhh_novedades.cargado_por = INTEGER

export const ROLES: Record<string, { label: string; color: string; permisos?: string[] }> = {
  dueno:     { label:"Dueño",      color:"#9333EA" },
  admin:     { label:"Admin",      color:"#3B82F6", permisos:["dashboard","ventas","compras","remitos","gastos","caja","proveedores","rrhh"] },
  encargado: { label:"Encargado",  color:"#6B7280", permisos:["dashboard"] },
  compras:   { label:"Compras",    color:"#8B5CF6", permisos:["compras","remitos","proveedores"] },
  cajero:    { label:"Cajero",     color:"#10B981", permisos:["caja","dashboard"] },
};

export const MODULOS = [
  { slug:"dashboard", label:"Dashboard", icon:"▦" },
  { slug:"ventas", label:"Ventas", icon:"↑" },
  { slug:"compras", label:"Facturas", icon:"📄" },
  { slug:"remitos", label:"Remitos", icon:"🚚" },
  { slug:"gastos", label:"Gastos", icon:"💸" },
  { slug:"proveedores", label:"Proveedores", icon:"🏭" },
  { slug:"costos", label:"Costos", icon:"📋" },
  { slug:"mp", label:"Conciliación MP", icon:"💳" },
  { slug:"caja", label:"Caja & Bancos", icon:"💰" },
  { slug:"caja_efectivo", label:"Caja Efectivo", icon:"💵" },
  { slug:"eerr", label:"Estado de Result.", icon:"📊" },
  { slug:"contador", label:"Contador / IVA", icon:"🧾" },
  { slug:"rrhh", label:"RRHH", icon:"💼" },
  { slug:"usuarios", label:"Usuarios", icon:"👥" },
];

// ─── FUNCIONES PURAS ─────────────────────────────────────────────────────────

export function getPermisos(user: any): string[] {
  if (!user) return [];
  if (user.rol === "dueno") return MODULOS.map(m => m.slug);
  if (user._permisos?.length) return user._permisos;
  return ROLES[user.rol]?.permisos || [];
}

export function tienePermiso(user: any, slug: string): boolean {
  if (!user) return false;
  if (user.rol === "dueno") return true;
  return getPermisos(user).includes(slug);
}

export function esEncargado(user: any): boolean {
  return user?.rol === "encargado";
}

/** null = todos los locales (dueno/admin). number[] para encargado. */
export function localesVisibles(user: any): number[] | null {
  if (!user) return [];
  if (user.rol === "dueno" || user.rol === "admin") return null;
  return user._locales?.length ? user._locales : (user.locales || []);
}

// ─── REACT CONTEXT + HOOK ────────────────────────────────────────────────────
// user en sesión: { id: number, nombre, email, rol: string, activo: boolean,
//   _permisos: string[], _locales: number[] }

const AuthContext = createContext<any>(null);
export const AuthProvider = AuthContext.Provider;

export function useAuth() {
  const user = useContext(AuthContext);
  return {
    user,
    tienePermiso: (slug: string) => tienePermiso(user, slug),
    esEncargado: () => esEncargado(user),
    localesVisibles: () => localesVisibles(user),
  };
}
