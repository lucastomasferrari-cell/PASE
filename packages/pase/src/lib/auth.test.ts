import { describe, it, expect } from "vitest";
import { scopeLocales, applyLocalScope, tienePermiso, getPermisos } from "./auth";
import type { Usuario } from "../types";

describe("scopeLocales", () => {
  const dueno = { rol: "dueno" };
  const admin = { rol: "admin" };
  const encBelgrano = { rol: "encargado", _locales: [1] };
  const encBelgranoVc = { rol: "encargado", _locales: [1, 2] };
  const encSinLocales = { rol: "encargado", _locales: [] };

  it("dueno sin localActivo → null (sin filtro)", () => {
    expect(scopeLocales(dueno, null)).toBeNull();
  });

  it("dueno con localActivo → [localActivo]", () => {
    expect(scopeLocales(dueno, 5)).toEqual([5]);
  });

  it("admin sin localActivo → null (sin filtro)", () => {
    expect(scopeLocales(admin, null)).toBeNull();
  });

  it("encargado con localActivo válido → [localActivo]", () => {
    expect(scopeLocales(encBelgranoVc, 2)).toEqual([2]);
  });

  it("encargado con localActivo fuera de scope → [] (match imposible)", () => {
    expect(scopeLocales(encBelgrano, 99)).toEqual([]);
  });

  it("encargado sin localActivo → sus locales visibles", () => {
    expect(scopeLocales(encBelgranoVc, null)).toEqual([1, 2]);
  });

  it("encargado sin locales asignados → []", () => {
    expect(scopeLocales(encSinLocales, null)).toEqual([]);
  });

  it("user null → [] (defensivo)", () => {
    expect(scopeLocales(null, null)).toEqual([]);
  });
});

describe("applyLocalScope", () => {
  // Mock partial del query builder de Supabase. `unknown` para los values
  // porque el mock acepta cualquier shape de filtro — el test inspecciona
  // las llamadas registradas, no los tipos.
  type Call = ["eq", string, unknown] | ["in", string, unknown[]];
  type MockQ = {
    calls: Call[];
    eq: (col: string, val: unknown) => MockQ;
    in: (col: string, vals: unknown[]) => MockQ;
  };
  const mkQ = (): MockQ => {
    const calls: Call[] = [];
    const q: MockQ = {
      calls,
      eq: (col, val) => { calls.push(["eq", col, val]); return q; },
      in: (col, vals) => { calls.push(["in", col, vals]); return q; },
    };
    return q;
  };

  it("dueno sin localActivo → query sin modificar", () => {
    const q = mkQ();
    const out = applyLocalScope(q, { rol: "dueno" }, null);
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("encargado sin locales → .eq(local_id, -1) (match imposible)", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [] }, null);
    expect(q.calls).toEqual([["eq", "local_id", -1]]);
  });

  it("encargado con un local → .eq(local_id, N)", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [3] }, null);
    expect(q.calls).toEqual([["eq", "local_id", 3]]);
  });

  it("encargado con múltiples locales → .in(local_id, [...])", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [1, 2] }, null);
    expect(q.calls).toEqual([["in", "local_id", [1, 2]]]);
  });

  it("encargado con localActivo válido → .eq(local_id, localActivo)", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [1, 2] }, 2);
    expect(q.calls).toEqual([["eq", "local_id", 2]]);
  });

  it("encargado con localActivo inválido → .eq(local_id, -1)", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [1] }, 99);
    expect(q.calls).toEqual([["eq", "local_id", -1]]);
  });

  it("respeta columna custom distinta de local_id", () => {
    const q = mkQ();
    applyLocalScope(q, { rol: "encargado", _locales: [5] }, null, "sucursal_id");
    expect(q.calls).toEqual([["eq", "sucursal_id", 5]]);
  });
});

// Helpers para los tests de tienePermiso / getPermisos
const userDueno = { rol: "dueno" } as Usuario;
const userAdmin = { rol: "admin" } as Usuario;
const userSuperadmin = { rol: "superadmin" } as Usuario;
const userEncCajaVentas = { rol: "encargado", _permisos: ["caja", "ventas"] } as Usuario;
const userEncMp = { rol: "encargado", _permisos: ["mp"] } as Usuario;
const userEncSinPermisos = { rol: "encargado", _permisos: [] } as Usuario;

describe("tienePermiso", () => {
  it("user null → false", () => {
    expect(tienePermiso(null, "caja")).toBe(false);
  });

  it("'tenants' es EXCLUSIVO de superadmin (ni dueno lo tiene)", () => {
    expect(tienePermiso(userSuperadmin, "tenants")).toBe(true);
    expect(tienePermiso(userDueno, "tenants")).toBe(false);
    expect(tienePermiso(userAdmin, "tenants")).toBe(false);
    expect(tienePermiso(userEncCajaVentas, "tenants")).toBe(false);
  });

  it("'inicio' lo tienen TODOS los usuarios autenticados", () => {
    expect(tienePermiso(userDueno, "inicio")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "inicio")).toBe(true);
    expect(tienePermiso(userEncSinPermisos, "inicio")).toBe(true);
  });

  it("'ajustes_dashboards' solo dueno/admin/superadmin", () => {
    expect(tienePermiso(userDueno, "ajustes_dashboards")).toBe(true);
    expect(tienePermiso(userAdmin, "ajustes_dashboards")).toBe(true);
    expect(tienePermiso(userSuperadmin, "ajustes_dashboards")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "ajustes_dashboards")).toBe(false);
  });

  it("'importar' solo dueno/admin/superadmin (no derivado de matriz)", () => {
    expect(tienePermiso(userDueno, "importar")).toBe(true);
    expect(tienePermiso(userAdmin, "importar")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "importar")).toBe(false);
  });

  it("'lector_mp' derivado: si tiene 'mp' (Conciliacion MP) puede usarlo", () => {
    expect(tienePermiso(userDueno, "lector_mp")).toBe(true);
    expect(tienePermiso(userEncMp, "lector_mp")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "lector_mp")).toBe(false);
  });

  it("dueno y superadmin ven todo (short-circuit)", () => {
    expect(tienePermiso(userDueno, "caja")).toBe(true);
    expect(tienePermiso(userDueno, "compras")).toBe(true);
    expect(tienePermiso(userSuperadmin, "rrhh")).toBe(true);
  });

  it("encargado: solo los slugs de su matriz", () => {
    expect(tienePermiso(userEncCajaVentas, "caja")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "ventas")).toBe(true);
    expect(tienePermiso(userEncCajaVentas, "compras")).toBe(false);
    expect(tienePermiso(userEncCajaVentas, "rrhh")).toBe(false);
  });
});

describe("getPermisos", () => {
  it("user null → []", () => {
    expect(getPermisos(null)).toEqual([]);
  });

  it("superadmin → TODOS los modulos (incluye 'tenants')", () => {
    const perms = getPermisos(userSuperadmin);
    expect(perms).toContain("tenants");
    expect(perms).toContain("caja");
    expect(perms).toContain("compras");
  });

  it("dueno → todos los modulos EXCEPTO 'tenants'", () => {
    const perms = getPermisos(userDueno);
    expect(perms).not.toContain("tenants");
    expect(perms).toContain("caja");
    expect(perms).toContain("compras");
  });

  it("encargado con matriz custom → solo esos slugs (sin 'tenants')", () => {
    const perms = getPermisos(userEncCajaVentas);
    expect(perms.sort()).toEqual(["caja", "ventas"]);
    expect(perms).not.toContain("tenants");
  });
});
