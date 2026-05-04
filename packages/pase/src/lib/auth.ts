import { createContext, useContext } from "react";
import type { Usuario } from "../types/auth";

// ─── TIPOS ───────────────────────────────────────────────────────────────────
// usuarios.id = INTEGER, usuarios.rol = TEXT, usuarios.locales = INTEGER[]
// locales.id = INTEGER
// usuario_permisos.usuario_id = INTEGER
// usuario_locales.usuario_id = INTEGER, local_id = INTEGER
// rrhh_novedades.cargado_por = INTEGER

// Las funciones de permisos pueden invocarse con:
//   - Usuario completo (sesión activa, hidratada con _permisos/_locales).
//   - null (sin sesión).
//   - undefined (context sin hidratar).
//   - Mocks parciales en tests (ej. \`{ rol: "encargado", _locales: [1,2] }\`)
//     — los tests verifican solo la lógica rol-based sin construir Usuarios
//     completos. Por eso usamos Partial<Usuario>: todos los campos opcionales,
//     pero typesafe en lectura porque las funciones hacen \`if (!user) return\`
//     y leen sólo lo que necesitan.
type MaybeUser = Partial<Usuario> | null | undefined;

export const ROLES: Record<string, { label: string; color: string; permisos?: string[] }> = {
  // superadmin: rol externo a tenants (TASK 0.15). Ve todos los módulos
  // como el dueño dentro de su tenant. La RPC auth_es_superadmin() lo
  // identifica en backend; en frontend se trata igual que 'dueno' para
  // permisos de UI (todos los módulos del MODULOS array).
  superadmin:{ label:"Super Admin",color:"#DC2626" },
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
  // Módulo solo para superadmin (TASK 0.15). Filtrado por getPermisos/tienePermiso
  // — no aparece en dropdowns de otros usuarios aunque esté en el array.
  { slug:"tenants", label:"Tenants", icon:"🏢" },
];

// ─── FUNCIONES PURAS ─────────────────────────────────────────────────────────

export function getPermisos(user: MaybeUser): string[] {
  if (!user) return [];
  // superadmin (TASK 0.15) ve TODOS los módulos incluyendo 'tenants'.
  if (user.rol === "superadmin") return MODULOS.map(m => m.slug);
  // Dueño/admin del tenant ven todos los módulos EXCEPTO 'tenants' (que es
  // exclusivo de superadmin).
  if (user.rol === "dueno") return MODULOS.filter(m => m.slug !== "tenants").map(m => m.slug);
  if (user._permisos?.length) return user._permisos.filter(s => s !== "tenants");
  // user.rol puede ser undefined cuando se invoca con mock parcial. ROLES[""]
  // devuelve undefined → ?.permisos → undefined → [] vacío. Comportamiento
  // equivalente al previo (con `any` el index access no se chequeaba).
  const rolKey = user.rol ?? "";
  return (ROLES[rolKey]?.permisos || []).filter(s => s !== "tenants");
}

export function tienePermiso(user: MaybeUser, slug: string): boolean {
  if (!user) return false;
  // 'tenants' es exclusivo de superadmin sin importar otros permisos.
  if (slug === "tenants") return user.rol === "superadmin";
  if (user.rol === "superadmin" || user.rol === "dueno") return true;
  return getPermisos(user).includes(slug);
}

export function esEncargado(user: MaybeUser): boolean {
  return user?.rol === "encargado";
}

/**
 * Decide qué hacer con localActivo para este usuario al loguearse/restaurar.
 * Parte del fix del bug #27: encargados con >1 local NO pueden operar con
 * localActivo=null, así que se les muestra un modal bloqueante.
 *
 * - dueno/admin         → "none" (dejan que el dropdown del sidebar decida)
 * - encargado 0 locales → "none" (sin locales no hay nada que elegir)
 * - encargado 1 local   → "setActivo" con ese local
 * - encargado >1 locales + stored válido en su lista → "setActivo" con stored
 * - encargado >1 locales + sin stored o stored inválido → "showModal"
 */
export function necesitaElegirLocal(
  user: MaybeUser,
  storedLocalActivo: number | null,
): { action: "none" | "setActivo" | "showModal"; localId?: number } {
  if (!user) return { action: "none" };
  if (user.rol === "dueno" || user.rol === "admin") return { action: "none" };
  const locs: number[] = user._locales?.length ? user._locales : (user.locales || []);
  if (locs.length === 0) return { action: "none" };
  if (locs.length === 1) return { action: "setActivo", localId: Number(locs[0]) };
  if (storedLocalActivo != null && locs.map(Number).includes(Number(storedLocalActivo))) {
    return { action: "setActivo", localId: Number(storedLocalActivo) };
  }
  return { action: "showModal" };
}

/** null = todos los locales (dueno/admin). number[] para encargado. */
export function localesVisibles(user: MaybeUser): number[] | null {
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
export function scopeLocales(user: MaybeUser, localActivo: number | null): number[] | null {
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
// Constraint estructural minimal sobre Q: el query builder debe tener
// .eq y .in chainables. Cualquier PostgrestFilterBuilder de Supabase los
// expone. El cast \`as Q\` post-llamada preserva el tipo concreto del builder
// que pasó el caller.
type LocalScopeFilterable = {
  eq: (col: string, val: number) => unknown;
  in: (col: string, vals: number[]) => unknown;
};
export function applyLocalScope<Q extends LocalScopeFilterable>(
  q: Q,
  user: MaybeUser,
  localActivo: number | null,
  col = "local_id",
): Q {
  const scope = scopeLocales(user, localActivo);
  if (scope === null) return q;
  if (scope.length === 0) return q.eq(col, -1) as Q; // match imposible
  if (scope.length === 1) return q.eq(col, scope[0]!) as Q;
  return q.in(col, scope) as Q;
}

/**
 * Cuentas de Tesorería cuyo SALDO el usuario puede ver (cards Tesorería,
 * totales del Cashflow). null = todas; [] = ninguna; string[] = solo esas.
 *
 * Llamada legacy `cuentasVisibles`. Mantenemos el nombre para no romper
 * los call-sites existentes; el alias semántico nuevo `cuentasVerSaldo`
 * apunta a la misma función.
 */
export function cuentasVisibles(user: MaybeUser): string[] | null {
  if (!user) return [];
  if (user.rol === "dueno" || user.rol === "admin") return null;
  if (user.cuentas_visibles === null || user.cuentas_visibles === undefined) return null;
  return user.cuentas_visibles;
}

/** Alias semántico de cuentasVisibles para código nuevo (Fase 2). */
export const cuentasVerSaldo = cuentasVisibles;

/**
 * Cuentas contra las que el usuario puede OPERAR (cargar pagos/gastos en
 * Compras, Remitos, RRHH, Caja, Gastos). null = todas; string[] = solo esas.
 *
 * Fallback histórico: la columna usuarios.cuentas_operables se agregó en
 * migration 202605041700. Hasta que esa migration corra en prod, la columna
 * llega undefined y caemos a cuentasVisibles (comportamiento previo).
 * Cuando Lucas corra la migration y empiece a setear cuentas_operables
 * desde el editor de Usuarios, este helper devuelve el array correcto.
 */
export function cuentasOperables(user: MaybeUser): string[] | null {
  if (!user) return [];
  if (user.rol === "dueno" || user.rol === "admin") return null;
  // Fallback gradual: si todavía no se migró cuentas_operables, leer
  // cuentas_visibles. Eso garantiza que el día que se mergee este código
  // pero antes de correr la migration, nadie pierde permisos de operar.
  if (user.cuentas_operables === undefined) return cuentasVisibles(user);
  if (user.cuentas_operables === null) return null;
  return user.cuentas_operables;
}

export function puedeVerCuenta(user: MaybeUser, cuenta: string): boolean {
  const vis = cuentasVisibles(user);
  if (vis === null) return true;
  return vis.includes(cuenta);
}

export function puedeOperarCuenta(user: MaybeUser, cuenta: string): boolean {
  const op = cuentasOperables(user);
  if (op === null) return true;
  return op.includes(cuenta);
}

/**
 * Cuentas que el usuario puede VER MOVIMIENTOS de (no saldos consolidados,
 * solo el listado del ledger). Es la unión de visibles ∪ operables —
 * coherente con "puedo pagar contra MP pero no veo cuánto hay en MP".
 *
 * null = sin restricción si CUALQUIERA de las dos es null. [] = ninguna.
 */
export function cuentasVisiblesParaListados(user: MaybeUser): string[] | null {
  const ver = cuentasVisibles(user);
  const op  = cuentasOperables(user);
  if (ver === null || op === null) return null;
  // Unión sin duplicados.
  return Array.from(new Set([...ver, ...op]));
}

export function puedeVerMovimientosDeCuenta(user: MaybeUser, cuenta: string): boolean {
  const lista = cuentasVisiblesParaListados(user);
  if (lista === null) return true;
  return lista.includes(cuenta);
}

// ─── REACT CONTEXT + HOOK ────────────────────────────────────────────────────
// user en sesión: { id: number, nombre, email, rol: string, activo: boolean,
//   _permisos: string[], _locales: number[] }

// El context guarda { user, refreshPermisos }. Retrocompat: si el value es
// un objeto user plano (sin refreshPermisos), se sigue leyendo como antes.
interface AuthContextValue {
  user: Usuario | null;
  refreshPermisos?: () => Promise<void>;
}
// El value del context puede ser:
//   - AuthContextValue (forma nueva: { user, refreshPermisos? })
//   - Usuario directo (forma legacy)
//   - null (sin sesión)
// useAuth() runtime-detecta cuál es por la presencia de .user.
type AuthContextRaw = AuthContextValue | Usuario | null;
const AuthContext = createContext<AuthContextRaw>(null);
export const AuthProvider = AuthContext.Provider;

export function useAuth() {
  const raw = useContext(AuthContext);
  // Permite dos formas de pasar el value: { user, refreshPermisos } (nuevo)
  // o el user directo (legacy). Detectamos por la presencia de .user.
  // Usuario tiene id/email/rol/etc. pero NO tiene una key llamada "user", así
  // que la presencia de "user" identifica AuthContextValue de forma única.
  const isWrapped = raw !== null && typeof raw === "object" && "user" in raw;
  const user: Usuario | null = isWrapped ? (raw as AuthContextValue).user : (raw as Usuario | null);
  const refreshPermisos = isWrapped ? (raw as AuthContextValue).refreshPermisos : undefined;
  return {
    user,
    tienePermiso: (slug: string) => tienePermiso(user, slug),
    esEncargado: () => esEncargado(user),
    localesVisibles: () => localesVisibles(user),
    scopeLocales: (localActivo: number | null) => scopeLocales(user, localActivo),
    cuentasVisibles: () => cuentasVisibles(user),
    puedeVerCuenta: (cuenta: string) => puedeVerCuenta(user, cuenta),
    refreshPermisos,
  };
}
