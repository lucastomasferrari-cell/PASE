import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { getCatalogoPorSlug, getPopulares, type CatalogoPublicoItem, type PopularItem } from '@/services/tiendaService';
import { Skeleton } from '@/components/ui/skeleton';
import { carritoStore, calcularSubtotal, type CarritoItem } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';
import { PillSelector } from './components/PillSelector';
import { CategoriaSidebar, CategoriaTabs, type CategoriaItem } from './components/CategoriaSidebar';
import { SeccionProductos } from './components/SeccionProductos';
import { CarritoSheet } from './components/CarritoSheet';
import type { ProductCardItem } from './components/ProductCard';
import { tiendaCarritoBadge } from './tiendaCarritoBadge';
import { DireccionAutocomplete } from '@/components/DireccionAutocomplete';
import { StarRating } from '@/components/StarRating';
import { listarReviewsPublicas, type ReviewsResumen } from '@/services/reviewsService';
import { JsonLd, buildRestaurantSchema } from '@/components/JsonLd';

const POPULARES_DIAS = 30;
const POPULARES_LIMIT = 8;
const POPULARES_KEY = 'popular';

// Mapea CatalogoPublicoItem (vista pública) a ProductCardItem (genérico).
// La vista expone color_ramp del grupo desde 2026-06-02 (chunk item-detalle F6).
function toCardItem(it: CatalogoPublicoItem | PopularItem): ProductCardItem {
  if ('precio_canal' in it) {
    return {
      item_id: it.item_id,
      nombre: it.nombre,
      descripcion: it.descripcion,
      emoji: it.emoji,
      foto_url: it.foto_url,
      precio: Number(it.precio_canal) || 0,
      grupo_color_ramp: it.grupo_color_ramp,
    };
  }
  return {
    item_id: it.item_id,
    nombre: it.nombre,
    descripcion: it.descripcion,
    emoji: it.emoji,
    foto_url: it.foto_url,
    precio: Number(it.precio) || 0,
    grupo_color_ramp: it.grupo_color_ramp ?? null,
  };
}

export function TiendaHome() {
  const { local } = useOutletContext<TiendaCtx>();
  const navigate = useNavigate();
  const [items, setItems] = useState<CatalogoPublicoItem[]>([]);
  const [populares, setPopulares] = useState<PopularItem[]>([]);
  const [loading, setLoading] = useState(true);
  // F6 SEO — resumen rating para Schema.org Restaurant. Se carga aparte
  // del que ya consume RatingResumen para no perforar el componente.
  const [reviewsResumen, setReviewsResumen] = useState<ReviewsResumen | null>(null);
  useEffect(() => {
    void listarReviewsPublicas(local.slug).then((r) => setReviewsResumen(r.data));
  }, [local.slug]);
  const [seccionActiva, setSeccionActiva] = useState<string | number | null>(null);
  const [carritoOpen, setCarritoOpen] = useState(false);
  const [search, setSearch] = useState('');
  const seccionesRef = useRef<Map<string, HTMLElement>>(new Map());

  // Sprint 7 HIGH #3: subscribe debe incluir local.slug en deps. Sin esto,
  // si el user navega a otra tienda, queda suscrito al store del slug anterior.
  const subscribe = useCallback((cb: () => void) => carritoStore.subscribe(cb), [local.slug]);
  const getSnapshot = useCallback(() => carritoStore.get(local.slug), [local.slug]);
  const carrito = useSyncExternalStore(subscribe, getSnapshot);

  const subtotal = calcularSubtotal(carrito.items);
  const costoEnvio = carrito.tipoEntrega === 'delivery' ? Number(local.costo_envio_default) || 0 : 0;
  const total = subtotal + costoEnvio;
  const itemsCount = carrito.items.reduce((s, x) => s + x.cantidad, 0);

  // Sincronizar count con el badge del header.
  useEffect(() => {
    tiendaCarritoBadge.setCount(itemsCount);
  }, [itemsCount]);

  // Header del layout dispara este evento al click en el badge.
  useEffect(() => tiendaCarritoBadge.onOpenRequest(() => setCarritoOpen(true)), []);

  // Cargar catálogo + populares en paralelo.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getCatalogoPorSlug(local.slug),
      getPopulares(local.slug, POPULARES_DIAS, POPULARES_LIMIT),
    ]).then(([cat, pop]) => {
      if (cancelled) return;
      setItems(cat.data);
      setPopulares(pop.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [local.slug]);

  const aceptaPedidos = local.features_pos_modos?.includes('pedidos') ?? false;

  // Agrupar items por grupo_id, filtrando por search si hay query.
  const grupos = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? items.filter((it) => it.nombre.toLowerCase().includes(q) || (it.descripcion ?? '').toLowerCase().includes(q))
      : items;
    const map = new Map<number, { id: number; nombre: string; emoji: string | null; items: CatalogoPublicoItem[] }>();
    const sinGrupo: CatalogoPublicoItem[] = [];
    for (const it of filtered) {
      if (it.grupo_id == null) {
        sinGrupo.push(it);
        continue;
      }
      const cur = map.get(it.grupo_id) ?? {
        id: it.grupo_id,
        nombre: it.grupo_nombre ?? '',
        emoji: it.grupo_emoji,
        items: [],
      };
      cur.items.push(it);
      map.set(it.grupo_id, cur);
    }
    const result = Array.from(map.values());
    if (sinGrupo.length > 0) {
      result.push({ id: -1, nombre: 'Otros', emoji: null, items: sinGrupo });
    }
    return result;
  }, [items, search]);

  // Sidebar items (Popular primero, luego grupos del catálogo).
  const categorias: CategoriaItem[] = useMemo(() => {
    const arr: CategoriaItem[] = [];
    if (populares.length > 0) arr.push({ id: POPULARES_KEY, nombre: 'Popular', emoji: '⭐' });
    for (const g of grupos) {
      arr.push({ id: g.id, nombre: g.nombre || 'Sin nombre', emoji: g.emoji });
    }
    return arr;
  }, [grupos, populares]);

  // Activa la primera al cargar.
  useEffect(() => {
    if (seccionActiva == null && categorias.length > 0) {
      setSeccionActiva(categorias[0]!.id);
    }
  }, [categorias, seccionActiva]);

  // IntersectionObserver: marca activa la sección visible al scrollear.
  useEffect(() => {
    if (categorias.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const id = (visible.target as HTMLElement).dataset.seccionId;
          if (id) setSeccionActiva(id);
        }
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    seccionesRef.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [categorias]);

  function registrarSeccion(id: string) {
    return (el: HTMLElement | null) => {
      if (el) seccionesRef.current.set(id, el);
      else seccionesRef.current.delete(id);
    };
  }

  function scrollASeccion(id: string | number) {
    setSeccionActiva(id);
    const el = seccionesRef.current.get(String(id));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function agregar(card: ProductCardItem) {
    // F6 chunk item-detalle (2026-06-02): si el item tiene modificadores
    // navegamos a la pantalla detalle en vez de agregar +1 directo. Sin
    // esto items con tamaño/extras se pedirían sin elegir → bloqueante.
    // El flag viene en `tiene_modificadores` de v_catalogo_publico.
    const original = items.find((x) => x.item_id === card.item_id);
    if (original?.tiene_modificadores) {
      navigate(`/tienda/${local.slug}/item/${card.item_id}`);
      return;
    }
    const next = { ...carrito };
    const idx = next.items.findIndex(
      (x) => x.item_id === card.item_id && x.modificadores.length === 0 && !x.notas,
    );
    if (idx >= 0) {
      next.items = next.items.map((x, i) => (i === idx ? { ...x, cantidad: x.cantidad + 1 } : x));
    } else {
      next.items = [...next.items, {
        item_id: card.item_id,
        nombre: card.nombre,
        emoji: card.emoji ?? null,
        precio: card.precio,
        cantidad: 1,
        modificadores: [],
        notas: '',
      } satisfies CarritoItem];
    }
    carritoStore.set(next);
    toast.success(`Agregado: ${card.nombre}`, { duration: 1500 });
  }

  function setCantidad(idx: number, delta: number) {
    const next = { ...carrito };
    const target = next.items[idx];
    if (!target) return;
    const nueva = target.cantidad + delta;
    next.items = nueva <= 0
      ? next.items.filter((_, i) => i !== idx)
      : next.items.map((x, i) => (i === idx ? { ...x, cantidad: nueva } : x));
    carritoStore.set(next);
  }

  function quitar(idx: number) {
    const next = { ...carrito };
    next.items = next.items.filter((_, i) => i !== idx);
    carritoStore.set(next);
  }

  function setTipoEntrega(t: 'retiro' | 'delivery') {
    if (t === 'delivery' && !local.acepta_delivery) return;
    carritoStore.set({ ...carrito, tipoEntrega: t });
  }

  function setDireccion(d: string, coords: { lat: number; lon: number } | null) {
    carritoStore.set({
      ...carrito,
      direccion: d,
      direccion_lat: coords?.lat ?? null,
      direccion_lon: coords?.lon ?? null,
    });
  }

  if (!aceptaPedidos) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <div className="text-5xl mb-4">🚧</div>
        <h2 className="text-xl font-medium text-foreground">Pedidos online pausados</h2>
        <p className="text-sm text-foreground/60 mt-3">
          Este local no acepta pedidos online por ahora.{' '}
          {local.telefono && <>Probá llamar al <strong>{local.telefono}</strong>.</>}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex">
        <aside className="hidden md:block w-60 flex-shrink-0 border-r border-gray-200 p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </aside>
        <div className="flex-1 max-w-5xl mx-auto p-6">
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-48 mb-6" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-square w-full rounded-2xl" />)}
          </div>
        </div>
      </div>
    );
  }

  // Sin items visibles para tienda.
  if (items.length === 0) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <div className="text-5xl mb-4">🍴</div>
        <h2 className="text-xl font-medium text-foreground">Estamos cargando la carta</h2>
        <p className="text-sm text-foreground/60 mt-3">
          Este local todavía no tiene productos en su carta online. Volvé en un rato.
        </p>
      </div>
    );
  }

  return (
    <div className="flex relative">
      {/* F6 SEO — Schema.org Restaurant para rich results en Google. */}
      <JsonLd
        keyId={`restaurant-${local.slug}`}
        data={buildRestaurantSchema({
          name: local.nombre,
          url: `${window.location.origin}/tienda/${local.slug}`,
          telephone: local.telefono ?? null,
          street: local.direccion ?? null,
          city: local.localidad ?? null,
          province: local.provincia ?? null,
          priceRange: '$$',
          aggregateRating: reviewsResumen && reviewsResumen.rating_promedio != null && reviewsResumen.total_reviews > 0
            ? { ratingValue: reviewsResumen.rating_promedio, reviewCount: reviewsResumen.total_reviews }
            : null,
          acceptsReservations: local.features_pos_modos?.includes('reservas') ?? false,
        })}
      />

      <CategoriaSidebar
        categorias={categorias}
        activa={seccionActiva}
        onClick={scrollASeccion}
        search={search}
        onSearchChange={setSearch}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <CategoriaTabs categorias={categorias} activa={seccionActiva} onClick={scrollASeccion} />

        <div className="flex-1 max-w-5xl w-full mx-auto px-5 sm:px-8 py-8 pb-32">
          {/* Hero local + resumen rating */}
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-medium tracking-tight">{local.nombre}</h1>
            {(local.direccion || local.telefono) && (
              <p className="text-sm text-foreground/60 mt-2">
                {local.direccion}
                {local.direccion && local.telefono && <span className="mx-2">·</span>}
                {local.telefono}
              </p>
            )}
            <RatingResumen localSlug={local.slug} />
          </div>

          {/* Pills entrega */}
          <PillSelector<'retiro' | 'delivery'>
            value={carrito.tipoEntrega}
            onChange={setTipoEntrega}
            options={[
              { value: 'retiro', label: 'Retiro' },
              { value: 'delivery', label: 'Delivery', disabled: !local.acepta_delivery },
            ]}
            className="mb-4"
          />

          {/* Selector hora — esta sesión solo ASAP. Programar = deuda. */}
          <div className="mb-6">
            <div className="text-xs text-foreground/60 mb-1.5 uppercase tracking-wide">
              {carrito.tipoEntrega === 'delivery' ? 'Tiempo de delivery' : 'Tiempo de retiro'}
            </div>
            <div className="inline-flex items-center justify-between min-w-[220px] h-11 px-4 rounded-md border border-gray-200 bg-white text-sm">
              <span>
                ASAP{' '}
                <span className="text-foreground/60">
                  · {carrito.tipoEntrega === 'delivery' ? local.tiempo_delivery_min : local.tiempo_retiro_min} min
                </span>
              </span>
            </div>
          </div>

          {/* Dirección (solo delivery) */}
          {carrito.tipoEntrega === 'delivery' && (
            <div className="mb-8">
              <label htmlFor="dir" className="block text-xs text-foreground/60 mb-1.5 uppercase tracking-wide">
                Dirección de entrega
              </label>
              <DireccionAutocomplete
                value={carrito.direccion}
                onChange={setDireccion}
                placeholder="Empezá a escribir: Av. Corrientes 1234..."
                provincia={local.provincia ?? null}
                localidad={local.localidad ?? null}
              />
              <p className="text-[10px] text-foreground/50 mt-1">
                Si tu dirección no aparece en las sugerencias, igual podés escribirla a mano.
              </p>
            </div>
          )}

          {/* Sección Discounts: omitida — sistema de promos pendiente */}

          {/* Sección Popular (scroll horizontal) */}
          {populares.length > 0 && (
            <div ref={registrarSeccion(POPULARES_KEY)} data-seccion-id={POPULARES_KEY} className="mb-12 scroll-mt-20">
              <SeccionProductos
                id={POPULARES_KEY}
                titulo="Popular"
                items={populares.map(toCardItem)}
                onAdd={agregar}
                variante="scroll"
              />
            </div>
          )}

          {/* Resto de las secciones (grid) */}
          {grupos.map((g) => (
            <div
              key={g.id}
              ref={registrarSeccion(String(g.id))}
              data-seccion-id={String(g.id)}
              className="mb-12 scroll-mt-20"
            >
              <SeccionProductos
                id={String(g.id)}
                titulo={`${g.emoji ? g.emoji + ' ' : ''}${g.nombre}`}
                items={g.items.map(toCardItem)}
                onAdd={agregar}
              />
            </div>
          ))}

          {/* Empty state si search no encuentra */}
          {search.trim() && grupos.length === 0 && populares.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">🔎</div>
              <p className="text-sm text-foreground/60">
                No encontramos nada con "{search}". Probá otra cosa.
              </p>
            </div>
          )}
        </div>

        {/* CTA fijo carrito mobile */}
        {itemsCount > 0 && (
          <button
            type="button"
            onClick={() => setCarritoOpen(true)}
            className="fixed bottom-4 left-4 right-4 md:hidden h-14 bg-primary text-primary-foreground rounded-full shadow-lg flex items-center justify-between px-6 text-sm font-medium z-30 active:scale-[.98] transition-transform"
          >
            <span>Ver carrito ({itemsCount})</span>
            <span className="font-semibold">{formatTotal(total)}</span>
          </button>
        )}
      </div>

      <CarritoSheet
        open={carritoOpen}
        onClose={() => setCarritoOpen(false)}
        items={carrito.items}
        subtotal={subtotal}
        costoEnvio={costoEnvio}
        total={total}
        tipoEntrega={carrito.tipoEntrega}
        direccion={carrito.direccion}
        slug={local.slug}
        onCantidad={setCantidad}
        onQuitar={quitar}
      />
    </div>
  );
}

// Inline para evitar import — formatARS está en lib/format.
function formatTotal(n: number): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 }).format(n);
}

// Resumen compacto de rating bajo el nombre del local (Marketplace Gap #3).
// Si no hay reviews aún, no renderiza nada.
function RatingResumen({ localSlug }: { localSlug: string }) {
  const [data, setData] = useState<ReviewsResumen | null>(null);
  useEffect(() => {
    void listarReviewsPublicas(localSlug).then((r) => setData(r.data));
  }, [localSlug]);
  if (!data || data.total_reviews === 0 || data.rating_promedio == null) return null;
  return (
    <div className="mt-3 inline-flex items-center gap-2">
      <StarRating value={data.rating_promedio} size="sm" />
      <span className="text-sm text-foreground/70">
        <strong>{data.rating_promedio.toFixed(1)}</strong>
        <span className="text-foreground/50"> · {data.total_reviews} opinion{data.total_reviews === 1 ? '' : 'es'}</span>
      </span>
    </div>
  );
}
