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
  admin:     { label:"Admin",      color:"#3B82F6", permisos:["negocio","finanzas","objetivos","ajustes","ventas","compras","remitos","gastos","caja","proveedores","rrhh","blindaje","eerr"] },
  encargado: { label:"Encargado",  color:"#6B7280", permisos:["caja","ventas"] },
  // Rol "compras" incluye compras_anular por retro-compatibilidad (antes
  // anulaba sin chequeo). Si querés un "compras lite" sin poder anular,
  // creá usuario sin rol fijo y asignale solo los slugs base via Usuarios.
  compras:   { label:"Compras",    color:"#8B5CF6", permisos:["compras","remitos","proveedores","compras_anular"] },
  cajero:    { label:"Cajero",     color:"#10B981", permisos:["caja","caja_anular"] },
};

// Permisos avanzados que NO son módulos navegables — son flags que controlan
// comportamientos finos dentro de pantallas existentes. Se gestionan desde
// la pantalla de Usuarios igual que los módulos, pero no aparecen en el
// sidebar. Default: ningún rol no-dueño los tiene; admin/dueño/superadmin
// los tienen siempre vía short-circuit en `tienePermiso`.
export const PERMISOS_EXTRAS = [
  { slug:"ventas_historico", label:"Ver histórico de ventas",
    descripcion:"Sin este permiso, el usuario solo ve el cierre que cargó en su sesión, no los cierres anteriores." },
  { slug:"ver_anulados", label:"Ver anulados / inactivos",
    descripcion:"Habilita los toggles 'Ver anulados' y 'Ver inactivos' en Caja, Proveedores y RRHH." },
  // Permisos *_anular (A-2 de la auditoría): separar "puedo entrar al módulo"
  // de "puedo anular operaciones financieras". Hoy quien tiene 'compras'
  // puede anular facturas vía RPC. Si no tiene 'compras_anular', el botón
  // queda disabled en UI; el backend igual valida (defense-in-depth).
  { slug:"compras_anular", label:"Anular facturas/remitos",
    descripcion:"Permite anular facturas y remitos desde Compras. Sin esto, el módulo es de solo carga/lectura." },
  { slug:"ventas_anular", label:"Anular ventas/cierres",
    descripcion:"Permite anular cierres de ventas. Sin esto, solo puede crear cierres pero no revertirlos." },
  { slug:"caja_anular", label:"Anular movimientos de caja",
    descripcion:"Permite anular movimientos en Tesorería. Sin esto, solo puede ver/editar; anular bloqueado." },
];

// MODULOS = lista maestra de slugs asignables como permisos. Incluye TODO
// lo que históricamente existió como módulo, incluso pantallas que hoy
// no aparecen en el sidebar consolidado de 10 items pero siguen siendo
// accesibles vía section state (deep-link, modales internos, etc.).
// Usuarios.tsx renderiza los checkboxes de permisos a partir de este array.
//
// Si una pantalla se elimina por completo del producto, sacarla también
// de acá. Si solo se la oculta del sidebar (caso 2026-05: Conciliación MP
// dentro de Caja, Proveedores dentro de Compras), mantener el slug acá.
export const MODULOS = [
  // Sidebar consolidado actual (Operación / Dirección / Módulos / Sistema)
  { slug:"caja", label:"Caja", icon:"💰" },
  { slug:"compras", label:"Compras", icon:"📄" },
  { slug:"ventas", label:"Ventas", icon:"↑" },
  // 'reservas' OCULTADO 2026-05-18 (Lucas: "no sirve de nada y en todo
  // caso vive en COMANDA"). La tabla `reservas` y la página standalone
  // siguen en el código. Si se decide moverlo a COMANDA, se mantiene
  // RLS + se mueve la UI allá.
  // { slug:"reservas", label:"Reservas", icon:"📅" },
  { slug:"negocio", label:"Negocio", icon:"📊" },
  { slug:"finanzas", label:"Finanzas", icon:"💼" },
  { slug:"objetivos", label:"Objetivos", icon:"◎" },
  { slug:"eerr", label:"Reportes", icon:"📊" },
  { slug:"rrhh", label:"Equipo", icon:"💼" },
  { slug:"ajustes", label:"Ajustes", icon:"⚙" },
  // Pantallas/sub-secciones accesibles internamente (no en sidebar top-level)
  { slug:"remitos", label:"Remitos", icon:"🚚" },
  { slug:"gastos", label:"Gastos", icon:"💸" },
  { slug:"proveedores", label:"Proveedores", icon:"🏭" },
  { slug:"mp", label:"Conciliación MP", icon:"💳" },
  { slug:"contador", label:"Contador / IVA", icon:"🧾" },
  { slug:"blindaje", label:"Blindaje", icon:"🛡" },
  { slug:"usuarios", label:"Usuarios", icon:"👥" },
  // Módulo solo para superadmin (TASK 0.15). Filtrado por getPermisos/tienePermiso
  // — no aparece en dropdowns de otros usuarios aunque esté en el array.
  { slug:"tenants", label:"Tenants", icon:"🏢" },
  // Cashflow eliminado del producto (Lucas, 2026-05-11).
  // Cierre Comparativo fusionado en EERR (Lucas, 2026-05-08).
  // Dashboard ("Inicio") y Movimientos eliminados del producto (2026-05-13).
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
  // 'inicio' (dashboard personalizado) lo tienen TODOS los usuarios autenticados.
  if (slug === "inicio") return true;
  // 'ajustes_dashboards' (config de dashboards de otros) solo dueño/admin/superadmin.
  if (slug === "ajustes_dashboards") {
    return user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";
  }
  // 'importar' (migración masiva CSV de proveedores/empleados/conceptos) solo
  // dueño/admin/superadmin. Encargados no migran data.
  if (slug === "importar") {
    return user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";
  }
  // 'lector_mp' (lector IA del extracto mensual de MercadoPago) — quien
  // tenga acceso al módulo 'mp' (Conciliación MP) puede usarlo. Si no, queda
  // restringido a dueño/admin/superadmin que ven todo.
  if (slug === "lector_mp") {
    if (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin") return true;
    return getPermisos(user).includes("mp");
  }
  // 'codigos_manager' (Manager Override TOTP — pantalla con códigos rotativos
  // de autorización). Solo dueño/admin/superadmin — el secret TOTP es
  // sensible y la RPC obtener_codigo_totp_actual valida el rol server-side.
  if (slug === "codigos_manager") {
    return user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";
  }
  // 'herramientas_hub' (pantalla con cards de herramientas avanzadas). Visible
  // si el user tiene acceso a AL MENOS UNA de las 7 herramientas que viven en
  // el hub. Si no tiene ninguna, el item no aparece en el sidebar.
  if (slug === "herramientas_hub") {
    if (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin") return true;
    const perms = getPermisos(user);
    return tienePermiso(user, "importar")
        || tienePermiso(user, "lector_mp")
        || tienePermiso(user, "ajustes_dashboards")
        || tienePermiso(user, "codigos_manager")
        || perms.includes("blindaje")
        || perms.includes("rrhh")
        || perms.includes("contador");
  }
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

const AuthContext = createContext<Usuario | null>(null);
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
