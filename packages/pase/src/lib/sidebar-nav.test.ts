import { describe, it, expect } from "vitest";
import { getDefaultRoute, SIDEBAR_ITEMS, SIDEBAR_SECTIONS, LEGACY_REDIRECTS } from "./sidebar-nav";
import type { Usuario } from "../types";

describe("getDefaultRoute", () => {
  it("user null → /ajustes (fallback)", () => {
    expect(getDefaultRoute(null)).toBe("/ajustes");
  });

  it("user undefined → /ajustes (fallback)", () => {
    expect(getDefaultRoute(undefined)).toBe("/ajustes");
  });

  it("dueno → /inicio (primer item del sidebar)", () => {
    expect(getDefaultRoute({ rol: "dueno" } as Usuario)).toBe("/inicio");
  });

  it("superadmin → /inicio (primer item)", () => {
    expect(getDefaultRoute({ rol: "superadmin" } as Usuario)).toBe("/inicio");
  });

  it("encargado SIN permisos → /inicio (todos los users tienen 'inicio')", () => {
    // Slug 'inicio' es excepcional: tienePermiso lo devuelve true para
    // todos los users autenticados. Por eso aparece como first item.
    const u = { rol: "encargado", _permisos: [] as string[] } as Usuario;
    expect(getDefaultRoute(u)).toBe("/inicio");
  });

  it("encargado con solo 'caja' aún cae en /inicio (primer match es 'inicio')", () => {
    const u = { rol: "encargado", _permisos: ["caja"] } as Usuario;
    expect(getDefaultRoute(u)).toBe("/inicio");
  });
});

describe("SIDEBAR_ITEMS", () => {
  it("incluye los 4 items de Operación esperados", () => {
    const op = SIDEBAR_ITEMS.filter(i => i.sec === "Operación").map(i => i.slug);
    expect(op).toContain("inicio");
    expect(op).toContain("caja");
    expect(op).toContain("compras");
    expect(op).toContain("ventas");
    expect(op).toContain("gastos");
  });

  it("incluye los items de Dirección", () => {
    const dir = SIDEBAR_ITEMS.filter(i => i.sec === "Dirección").map(i => i.slug);
    expect(dir).toEqual(expect.arrayContaining(["negocio", "finanzas", "objetivos", "eerr"]));
  });

  it("incluye 'tenants' (solo visible si superadmin)", () => {
    expect(SIDEBAR_ITEMS.some(i => i.slug === "tenants")).toBe(true);
  });

  it("todos los paths empiezan con /", () => {
    for (const item of SIDEBAR_ITEMS) {
      expect(item.path.startsWith("/")).toBe(true);
    }
  });

  it("no hay paths duplicados", () => {
    const paths = SIDEBAR_ITEMS.map(i => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("no hay slugs duplicados", () => {
    const slugs = SIDEBAR_ITEMS.map(i => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("toda sec está en SIDEBAR_SECTIONS", () => {
    for (const item of SIDEBAR_ITEMS) {
      expect(SIDEBAR_SECTIONS).toContain(item.sec);
    }
  });
});

describe("LEGACY_REDIRECTS", () => {
  it("URLs legacy típicas redirigen donde deben", () => {
    expect(LEGACY_REDIRECTS["/rrhh"]).toBe("/equipo");
    expect(LEGACY_REDIRECTS["/proveedores"]).toBe("/compras/proveedores");
    expect(LEGACY_REDIRECTS["/conciliacion-mp"]).toBe("/caja/conciliacion");
    expect(LEGACY_REDIRECTS["/contador"]).toBe("/herramientas/contador-iva");
  });

  it("usa sentinel @default para dashboard/inicio (redirige a getDefaultRoute)", () => {
    expect(LEGACY_REDIRECTS["/inicio"]).toBe("@default");
    expect(LEGACY_REDIRECTS["/dashboard"]).toBe("@default");
  });

  it("ningún destino apunta a un legacy del mismo mapa (sin loops)", () => {
    const legacyKeys = new Set(Object.keys(LEGACY_REDIRECTS));
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      if (to === "@default") continue;
      // El destino NO debe ser otra clave del mapa (eso causaría double-redirect)
      expect(legacyKeys.has(to)).toBe(false);
      expect(to).not.toBe(from);
    }
  });
});
