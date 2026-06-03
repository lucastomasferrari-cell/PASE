import { test, expect } from "@playwright/test";

// Test mutante: GET /api/sitemap genera XML válido con URLs públicas
// (F6 Brainstorm #8 — chunk SEO, 2026-06-02).
//
// El sitemap se sirve desde pase-yndx.vercel.app/api/sitemap y se proxy
// rewriteea en COMANDA a /sitemap.xml. Este test hace request directo
// al endpoint en PROD para validar:
//
//   1. Status 200 + Content-Type application/xml
//   2. XML bien formado con declaración + <urlset> raíz
//   3. Incluye URL de marketplace
//   4. Incluye al menos 1 URL de /tienda/{slug}
//   5. Cache-Control declara public (importante para SEO + edge)
//   6. NO leakea data privada — todas las URLs son `/tienda/`, `/marketplace`,
//      `/tienda/{slug}/item/{id}` (NUNCA /pos, /caja, /settings, etc.).
//
// El test es read-only: NO crea ni modifica nada en DB. Solo lee el
// endpoint público que ya sirve prod.

const SITEMAP_URL = process.env.E2E_SITEMAP_URL ?? "https://pase-yndx.vercel.app/api/sitemap";

test.describe("Sitemap SEO mutante", () => {
  let xml: string;
  let response: Response;

  test.beforeAll(async () => {
    response = await fetch(SITEMAP_URL);
    xml = await response.text();
  });

  test("MUTANTE: responde 200 con Content-Type XML", () => {
    expect(response.status).toBe(200);
    const ct = response.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("xml"); // MUTANTE: si el setHeader se rompe, viene text/html
  });

  test("MUTANTE: XML bien formado con urlset raíz", () => {
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("</urlset>");
    // No debe tener errores de plantilla a medio resolver
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("[object Object]");
  });

  test("MUTANTE: incluye URL marketplace cross-tenant", () => {
    expect(xml).toContain("/marketplace</loc>"); // MUTANTE: si se borra la entry root, falla
  });

  test("MUTANTE: incluye al menos 1 URL de tienda con slug", () => {
    const tiendaMatches = xml.match(/<loc>[^<]*\/tienda\/[^/<]+<\/loc>/g) ?? [];
    expect(tiendaMatches.length).toBeGreaterThan(0); // MUTANTE: si la query de v_locales_publicos falla silenciosamente, viene 0
  });

  test("MUTANTE: Cache-Control declara public para edge caching", () => {
    const cc = response.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
    expect(cc).toMatch(/max-age=\d+/); // MUTANTE: si el header se rompe, sin max-age Google penaliza
  });

  test("MUTANTE: NO leakea URLs privadas (admin/pos/caja/settings)", () => {
    // Si por error alguien expone otras vistas, no debe colarse acá.
    expect(xml).not.toMatch(/<loc>[^<]*\/pos\//);
    expect(xml).not.toMatch(/<loc>[^<]*\/caja\//);
    expect(xml).not.toMatch(/<loc>[^<]*\/settings/);
    expect(xml).not.toMatch(/<loc>[^<]*\/configuracion/);
    expect(xml).not.toMatch(/<loc>[^<]*\/reportes/);
    expect(xml).not.toMatch(/<loc>[^<]*\/login/);
    expect(xml).not.toMatch(/<loc>[^<]*\/admin/);
  });

  test("MUTANTE: URLs usan https + dominio público correcto", () => {
    // Todas las <loc> deben empezar con https://, no http://
    const locs = xml.match(/<loc>([^<]+)<\/loc>/g) ?? [];
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(loc).toMatch(/<loc>https:\/\//);
      // No debe quedar el placeholder localhost
      expect(loc).not.toContain("localhost");
    }
  });
});
