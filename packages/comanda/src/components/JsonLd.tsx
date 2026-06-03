// Componente helper que inyecta un <script type="application/ld+json"> en
// el <head>, para que Google/Bing reconozcan datos estructurados
// Schema.org sin que aparezca en el body visible.
//
// F6 Brainstorm #8 — chunk SEO (2026-06-02). Trabaja en conjunto con
// sitemap.xml y robots.txt. El sitemap dice "esta URL existe", JSON-LD
// dice "y este es un Restaurant con estos atributos" para que el SERP
// muestre rich results (estrellas, precio, foto del plato).
//
// Patrón: useEffect crea <script> en mount, lo borra en unmount. Usa
// data attribute para identificar el script en el DOM (evita duplicar si
// la pantalla se renderiza 2 veces).
//
// Validar el output con:
//   - https://validator.schema.org/
//   - https://search.google.com/test/rich-results
//
// Cada componente que use JsonLd debe pasar un `keyId` único para que
// múltiples instancias en la misma pantalla (Restaurant + ItemList +
// MenuItem) no se pisen.

import { useEffect } from "react";

interface Props {
  /** Identificador único para distinguir scripts en el DOM. Ej: 'restaurant',
   *  'menuItem-42'. Sin este, montar 2 componentes con el mismo schema
   *  reemplaza al anterior. */
  keyId: string;
  /** Objeto JSON-LD. Debe incluir @context y @type. Será JSON.stringify-eado. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

export function JsonLd({ keyId, data }: Props) {
  useEffect(() => {
    const id = `jsonld-${keyId}`;
    // Si ya existe (montaje doble en StrictMode), reemplazar contenido.
    let script = document.querySelector<HTMLScriptElement>(`script[data-jsonld-id="${id}"]`);
    if (!script) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.dataset.jsonldId = id;
      document.head.appendChild(script);
    }
    try {
      script.textContent = JSON.stringify(data);
    } catch (err) {
      // Si data tiene una referencia circular, no rompemos la app.
      console.warn(`[JsonLd] failed to stringify schema ${id}:`, err);
    }
    return () => {
      const existing = document.querySelector(`script[data-jsonld-id="${id}"]`);
      if (existing) existing.remove();
    };
  }, [keyId, data]);

  return null;
}

// ─── Helpers que arman los schemas más comunes ─────────────────────────

/**
 * Schema.org Restaurant — para la home de cada tienda.
 * Google muestra: nombre, address, foto, rating, priceRange en SERP.
 */
export function buildRestaurantSchema(args: {
  name: string;
  url: string;
  image?: string | null;
  telephone?: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  servesCuisine?: string;
  priceRange?: string;
  aggregateRating?: { ratingValue: number; reviewCount: number } | null;
  acceptsReservations?: boolean;
}): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    "name": args.name,
    "url": args.url,
  };
  if (args.image) schema.image = args.image;
  if (args.telephone) schema.telephone = args.telephone;
  if (args.street || args.city) {
    schema.address = {
      "@type": "PostalAddress",
      "addressCountry": "AR",
    };
    if (args.street) schema.address.streetAddress = args.street;
    if (args.city) schema.address.addressLocality = args.city;
    if (args.province) schema.address.addressRegion = args.province;
  }
  if (args.servesCuisine) schema.servesCuisine = args.servesCuisine;
  if (args.priceRange) schema.priceRange = args.priceRange;
  if (args.aggregateRating && args.aggregateRating.reviewCount > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": args.aggregateRating.ratingValue.toFixed(1),
      "reviewCount": args.aggregateRating.reviewCount,
      "bestRating": "5",
      "worstRating": "1",
    };
  }
  if (args.acceptsReservations != null) {
    schema.acceptsReservations = args.acceptsReservations;
  }
  return schema;
}

/**
 * Schema.org MenuItem — para la pantalla detalle de un plato.
 * Google puede mostrarlo como "Producto" en SERP con precio + foto.
 */
export function buildMenuItemSchema(args: {
  name: string;
  description?: string | null;
  image?: string | null;
  price: number;
  url: string;
}): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "MenuItem",
    "name": args.name,
    "url": args.url,
    "offers": {
      "@type": "Offer",
      "price": args.price.toFixed(2),
      "priceCurrency": "ARS",
      "availability": "https://schema.org/InStock",
    },
  };
  if (args.description) schema.description = args.description;
  if (args.image) schema.image = args.image;
  return schema;
}
