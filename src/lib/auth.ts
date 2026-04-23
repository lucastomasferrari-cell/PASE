import { createContext, useContext } from "react";

// ─── TIPOS ───────────────────────────────────────────────────────────────────
// usuarios.id = INTEGER, usuarios.rol = TEXT, usuarios.locales = INTEGER[]
// locales.id = INTEGER
// usuario_permisos.usuario_id = INTEGER
// usuario_locales.usuario_id = INTEGER, local_id = INTEGER
// rrhh_novedades.cargado_por = INTEGER

export const ROLES: Record<string, { label: string; color: string; permisos?: string[] }> = {
  dueno:     { label:"Dueño",      color:"#9333EA" },
  admin:     { label:"Admin",      color:"#3B82F6", permisos:["dashboard","ventas","compras","remitos","gastos","caja","cashflow","cierre","proveedores","rrhh","blindaje"] },
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
  { slug:"caja", label:"Tesorería", icon:"💰" },
  { slug:"cashflow", label:"Cashflow", icon:"📈" },
  { slug:"cierre", label:"Cierre Comparativo", icon:"📊" },
  { slug:"eerr", label:"Estado de Result.", icon:"📊" },
  { slug:"contador", label:"Contador / IVA", icon:"🧾" },
  { slug:"rrhh", label:"RRHH", icon:"💼" },
  { slug:"blindaje", label:"Blindaje", icon:"🛡" },
  { slug:"usuarios", label:"Usuarios", icon:"👥" },
  { slug:"configuracion", label:"Conceptos", icon:"⚙" },
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

/**
 * Combina localesVisibles(user) con localActivo (el dropdown del sidebar).
 *  null     → no filtrar (dueno/admin sin localActivo)
 *  []       → ningún local accesible → la query debe devolver vacío
 *  number[] → filtrar por estos locales
 */
export function scopeLocales(user: any, localActivo: number | null): number[] | null {
  const visibles = localesVisibles(user);
  if (localActivo != null) {
    if (visibles === null) return [localActivo];
    return visibles.includes(localActivo) ? [localActivo] : [];
  }
  return visibles;
}

/**
 * Aplica scopeLocales a un query builder de Supabase. Usar en toda tabla con local_id.
 *   let q = db.from("facturas").select("*").eq("prov_id", p.id);
 *   q = applyLocalScope(q, user, localActivo);
 */
export function applyLocalScope<Q>(q: Q, user: any, localActivo: number | null, col = "local_id"): Q {
  const scope = scopeLocales(user, localActivo);
  if (scope === null) return q;
  if (scope.length === 0) return (q as any).eq(col, -1); // match imposible
  if (scope.length === 1) return (q as any).eq(col, scope[0]);
  return (q as any).in(col, scope);
}

/**
 * Cuentas de Tesorería visibles por el usuario.
 *   null    → todas (dueno/admin, o usuario viejo sin setear)
 *   []      → ninguna
 *   string[]→ sólo esas
 */
export function cuentasVisibles(user: any): string[] | null {
  if (!user) return [];
  if (user.rol === "dueno" || user.rol === "admin") return null;
  if (user.cuentas_visibles === null || user.cuentas_visibles === undefined) return null;
  return user.cuentas_visibles;
}

export function puedeVerCuenta(user: any, cuenta: string): boolean {
  const vis = cuentasVisibles(user);
  if (vis === null) return true;
  return vis.includes(cuenta);
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
    scopeLocales: (localActivo: number | null) => scopeLocales(user, localActivo),
    cuentasVisibles: () => cuentasVisibles(user),
    puedeVerCuenta: (cuenta: string) => puedeVerCuenta(user, cuenta),
  };
}
