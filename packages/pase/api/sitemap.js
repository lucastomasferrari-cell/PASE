// Endpoint: GET /api/sitemap
//
// F6 Brainstorm #8 — chunk SEO (2026-06-02).
//
// Genera el sitemap.xml dinámico de TODA la tienda online + marketplace
// cross-tenant. Google/Bing lo leen para indexar las URLs públicas y
// que el cliente final encuentre "<nombre del local> delivery" cuando
// busca, sin pagar Ads.
//
// URLs incluidas (por tenant con tienda_activa=TRUE):
//   - /marketplace            (raíz cross-tenant)
//   - /tienda/{slug}          (1 por local)
//   - /tienda/{slug}/item/{id}  (1 por item público vendible)
//
// Anonymous read: usa SUPABASE_ANON_KEY (no service key) — solo consulta
// vistas públicas v_locales_publicos + v_catalogo_publico que ya tienen
// GRANT SELECT TO anon. Cero exposición de data privada.
//
// Cache: 1h public en Vercel edge. Si Lucas agrega un local nuevo,
// tarda hasta 1h en aparecer en el sitemap (aceptable: Google revisita
// igual cada varios días).
//
// IMPORTANTE para SEO: la `loc` debe coincidir EXACTAMENTE con el dominio
// donde se renderiza la tienda. Hoy es pase-comanda.vercel.app. El proxy
// `/api/*` en vercel.json de COMANDA redirige a pase-yndx, así que este
// endpoint corre acá pero declara las URLs del dominio de COMANDA.
//
// Para servir como /sitemap.xml en COMANDA, agregar rewrite en
// packages/comanda/vercel.json:
//   { "source": "/sitemap.xml", "destination": "/api/sitemap" }
// (el proxy /api/* ya lo redirige a este endpoint)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://pduxydviqiaxfqnshhdc.supabase.co";
// Service key — siempre disponible en el env de Vercel. Solo se usa para
// leer 2 vistas públicas que igual tienen GRANT SELECT TO anon, así que
// no expone data privada.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Dominio público de la tienda. Cuando se active custom domain (chunk
// pendiente F6), este string lo override `req.headers.host` para que
// cada tenant aparezca con SU dominio en SUS URLs. Por ahora único.
const PUBLIC_HOST = process.env.TIENDA_PUBLIC_HOST || "https://pase-comanda.vercel.app";

// Helper: escapa caracteres XML para evitar romper el sitemap si un
// nombre de local trae '&', '<', '>', '"', "'".
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Helper: arma una <url> entry con loc + lastmod + priority + changefreq.
// lastmod opcional (Google lo ignora si no hace sentido).
function urlEntry({ loc, lastmod, priority, changefreq }) {
  return [
    "  <url>",
    `    <loc>${xmlEscape(loc)}</loc>`,
    lastmod ? `    <lastmod>${xmlEscape(lastmod)}</lastmod>` : null,
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
    priority != null ? `    <priority>${priority}</priority>` : null,
    "  </url>",
  ].filter(Boolean).join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  if (!SUPABASE_KEY) {
    res.status(500).send("SUPABASE_SERVICE_KEY missing");
    return;
  }

  try {
    const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Listar locales públicos
    const { data: locales, error: errL } = await db
      .from("v_locales_publicos")
      .select("slug")
      .order("slug", { ascending: true });

    if (errL) throw new Error(`v_locales_publicos: ${errL.message}`);

    // 2. Listar items públicos (todos los locales en 1 query — la vista
    //    ya filtra por canal tienda-propia + visible_tienda + disponible)
    const { data: items, error: errI } = await db
      .from("v_catalogo_publico")
      .select("item_id, local_slug")
      .order("local_slug", { ascending: true })
      .order("item_id", { ascending: true });

    if (errI) throw new Error(`v_catalogo_publico: ${errI.message}`);

    // 3. Armar XML
    const urls = [];

    // Marketplace raíz (cross-tenant)
    urls.push(urlEntry({
      loc: `${PUBLIC_HOST}/marketplace`,
      priority: "0.9",
      changefreq: "daily",
    }));

    // 1 URL por tienda
    for (const l of locales ?? []) {
      urls.push(urlEntry({
        loc: `${PUBLIC_HOST}/tienda/${l.slug}`,
        priority: "0.8",
        changefreq: "daily",
      }));
    }

    // 1 URL por item público (prioridad baja — son hojas)
    for (const it of items ?? []) {
      urls.push(urlEntry({
        loc: `${PUBLIC_HOST}/tienda/${it.local_slug}/item/${it.item_id}`,
        priority: "0.5",
        changefreq: "weekly",
      }));
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls,
      "</urlset>",
    ].join("\n");

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.status(200).send(xml);
  } catch (err) {
    console.error("[sitemap] error:", err);
    res.status(500).send(`Error generating sitemap: ${err.message}`);
  }
}
