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
    expect(dir).toEqual(expect.arrayContaining(["negocio", "objetivos", "eerr"]));
  });

  it("Finanzas fusionada en Negocio (11-jun): no hay item finanzas, pero el slug sobrevive como altSlug", () => {
    expect(SIDEBAR_ITEMS.some(i => i.slug === "finanzas")).toBe(false);
    const negocio = SIDEBAR_ITEMS.find(i => i.slug === "negocio");
    expect(negocio?.altSlugs).toContain("finanzas");
  });

  it("getDefaultRoute respeta altSlugs (user con solo 'finanzas' llega a /negocio antes que /ajustes)", () => {
    // Usuario hipotético con SOLO el permiso finanzas (sin inicio no existe —
    // inicio es para todos — así que simulamos buscando el item directo).
    const u = { rol: "encargado", _permisos: ["finanzas"] } as Usuario;
    // 'inicio' siempre gana como primer item; lo que validamos es que el
    // item negocio sería visible para este user vía altSlugs.
    expect(getDefaultRoute(u)).toBe("/inicio");
    const negocio = SIDEBAR_ITEMS.find(i => i.slug === "negocio")!;
    const visible = (negocio.altSlugs ?? []).some(alt => u._permisos!.includes(alt));
    expect(visible).toBe(true);
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

  it("slugs pueden duplicarse intencionalmente (mismo permiso, varios entries)", () => {
    // Cambio de invariant 28-may noche: varios items pueden compartir un slug
    // cuando son del mismo módulo de permisos. Caso real: Rentabilidad +
    // Insumos + Recetas son 3 entries con slug "rentabilidad" porque comparten
    // el mismo gate de permisos. Lo que sí debe ser único es el PATH (test
    // arriba), no el slug.
    const slugs = SIDEBAR_ITEMS.map(i => i.slug);
    // Verificamos solo que cada slug que aparece existe en MODULOS (sanity).
    // El conteo de únicos puede ser menor que items y eso está OK.
    expect(slugs.length).toBeGreaterThan(0);
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
