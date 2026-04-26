import { describe, it, expect } from "vitest";
import { scopeLocales, applyLocalScope } from "./auth";

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
  const mkQ = () => {
    const calls: any[] = [];
    const q: any = {
      calls,
      eq: (col: string, val: any) => { calls.push(["eq", col, val]); return q; },
      in: (col: string, vals: any[]) => { calls.push(["in", col, vals]); return q; },
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
