import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, MapPin, ExternalLink, Store, Clock, Share2, Navigation, NavigationOff } from 'lucide-react';
import { listMarketplaceLocales, type LocalMarketplace } from '@/services/marketplaceService';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useGeolocation } from '@/lib/useGeolocation';
import { haversineKm } from '@/lib/geo';
import { cn } from '@/lib/utils';

// Marketplace público — feed cross-tenant de locales que activaron
// visible_marketplace. NO requiere auth. El usuario navega, descubre
// restaurantes y entra a la tienda online (/tienda/<slug>) para pedir.
//
// Es la versión inicial (estructura): falta geolocalización + rating +
// filtros por radio. Por ahora: search por nombre + chips de tags +
// grid de cards.

type SortBy = 'abiertos' | 'nombre' | 'rapido' | 'cercanos';
type RadioFiltro = 'todos' | '5' | '10' | '20';
const PAGE_SIZE = 24;

export function MarketplaceHome() {
  const [locales, setLocales] = useState<LocalMarketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tagFiltro, setTagFiltro] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('abiertos');
  const [radioFiltro, setRadioFiltro] = useState<RadioFiltro>('todos');
  const [pagina, setPagina] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const geo = useGeolocation(true);

  // SEO/OG tags básicos sin React Helmet — manipulación directa del head
  useEffect(() => {
    document.title = 'Marketplace · Pedí online a restaurantes';
    const setMeta = (name: string, content: string, isProperty = false) => {
      const attr = isProperty ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.content = content;
    };
    setMeta('description', 'Encontrá restaurantes que aceptan pedidos online. Sushi, pizza, japonesa y más — sin intermediarios.');
    setMeta('og:title', 'Marketplace de restaurantes', true);
    setMeta('og:description', 'Pedí online directo al restaurante, sin intermediarios.', true);
    setMeta('og:type', 'website', true);
    if (typeof window !== 'undefined') setMeta('og:url', window.location.href, true);
  }, []);

  useEffect(() => {
    listMarketplaceLocales().then(({ data, error: err }) => {
      if (err) setError(err);
      setLocales(data);
      setLoading(false);
    });
  }, []);

  // Reset paginación al cambiar filtros
  useEffect(() => { setPagina(1); }, [debouncedSearch, tagFiltro, sortBy, radioFiltro]);

  // Auto-switch a sort 'cercanos' la primera vez que el user dio permiso
  // (preserva la decisión consciente si después cambia a otro sort).
  useEffect(() => {
    if (geo.status === 'granted' && sortBy === 'abiertos') {
      setSortBy('cercanos');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.status === 'granted']);

  // Tags únicos para chips de filtro
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const l of locales) {
      for (const t of l.marketplace_tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [locales]);

  // Adornamos cada local con `distanciaKm` cuando tenemos coords del user
  // y coords del local. Null si falta alguno.
  const localesConDist = useMemo(() => {
    return locales.map((l) => {
      const dist = (geo.data && l.lat != null && l.lon != null)
        ? haversineKm(geo.data.lat, geo.data.lon, Number(l.lat), Number(l.lon))
        : null;
      return { ...l, distanciaKm: dist };
    });
  }, [locales, geo.data]);

  const localesFiltrados = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const filtered = localesConDist.filter((l) => {
      if (q && !l.nombre.toLowerCase().includes(q) && !(l.marketplace_descripcion ?? '').toLowerCase().includes(q)) {
        return false;
      }
      if (tagFiltro && !(l.marketplace_tags ?? []).includes(tagFiltro)) {
        return false;
      }
      // Filtro por radio (solo aplica si tenemos coords del cliente)
      if (radioFiltro !== 'todos' && geo.data) {
        const max = Number(radioFiltro);
        // Locales sin coords se ocultan cuando hay filtro activo (no podemos
        // saber si están cerca — mejor esconderlos que mostrarlos sin distancia).
        if (l.distanciaKm == null) return false;
        if (l.distanciaKm > max) return false;
      }
      return true;
    });
    // Sort
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'abiertos':
          if (a.abierto_ahora !== b.abierto_ahora) return b.abierto_ahora ? 1 : -1;
          return a.nombre.localeCompare(b.nombre);
        case 'nombre':
          return a.nombre.localeCompare(b.nombre);
        case 'rapido':
          return (a.tiempo_delivery_min ?? 999) - (b.tiempo_delivery_min ?? 999);
        case 'cercanos':
          // Locales con distancia conocida primero, ascendente. Sin coords al final.
          if (a.distanciaKm == null && b.distanciaKm == null) return a.nombre.localeCompare(b.nombre);
          if (a.distanciaKm == null) return 1;
          if (b.distanciaKm == null) return -1;
          return a.distanciaKm - b.distanciaKm;
        default: return 0;
      }
    });
    return sorted;
  }, [localesConDist, debouncedSearch, tagFiltro, sortBy, radioFiltro, geo.data]);

  const totalPaginas = Math.max(1, Math.ceil(localesFiltrados.length / PAGE_SIZE));
  const localesPagina = localesFiltrados.slice((pagina - 1) * PAGE_SIZE, pagina * PAGE_SIZE);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero header */}
      <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-background border-b border-border">
        <div className="container max-w-5xl py-10 px-4">
          <div className="flex items-center gap-3 mb-3">
            <Store className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
          </div>
          <p className="text-muted-foreground max-w-2xl">
            Restaurantes que aceptan pedidos online. Elegí tu favorito y pedí directo — sin intermediarios.
          </p>

          {/* Search */}
          <div className="mt-6 max-w-md relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar restaurante o tipo de comida…"
              className="pl-12 h-12 text-base"
            />
          </div>
        </div>
      </div>

      <div className="container max-w-5xl py-6 px-4">
        {/* Toolbar: tags + sort */}
        <div className="mb-6 flex items-center gap-3 flex-wrap">
          {tags.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap overflow-x-auto -mx-1 px-1 max-w-full">
              <button
                type="button"
                onClick={() => setTagFiltro(null)}
                className={cn(
                  'px-3 h-8 rounded-full text-sm transition-colors shrink-0',
                  tagFiltro === null
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent',
                )}
              >
                Todos
              </button>
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTagFiltro(t)}
                  className={cn(
                    'px-3 h-8 rounded-full text-sm transition-colors shrink-0',
                    tagFiltro === t
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {!loading && locales.length > 0 && (
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              {/* Geolocalización: pedir / mostrar status / limpiar */}
              {geo.status === 'idle' || geo.status === 'denied' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={geo.request}
                  className="gap-1.5 h-9"
                  title="Mostrar restaurantes ordenados por cercanía"
                >
                  <Navigation className="h-3.5 w-3.5" />
                  Cerca de mí
                </Button>
              ) : geo.status === 'loading' ? (
                <Button variant="outline" size="sm" disabled className="gap-1.5 h-9">
                  <Navigation className="h-3.5 w-3.5 animate-pulse" />
                  Detectando…
                </Button>
              ) : geo.status === 'granted' ? (
                <>
                  <Select value={radioFiltro} onValueChange={(v) => setRadioFiltro(v as RadioFiltro)}>
                    <SelectTrigger className="w-[140px] h-9 gap-1">
                      <Navigation className="h-3 w-3 text-success" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todos">Sin radio</SelectItem>
                      <SelectItem value="5">≤ 5 km</SelectItem>
                      <SelectItem value="10">≤ 10 km</SelectItem>
                      <SelectItem value="20">≤ 20 km</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={geo.clear}
                    className="h-9 w-9 p-0"
                    title="Olvidar mi ubicación"
                  >
                    <NavigationOff className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : null}
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger className="w-[170px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abiertos">Abiertos primero</SelectItem>
                  <SelectItem value="nombre">Por nombre A-Z</SelectItem>
                  <SelectItem value="rapido">Más rápidos</SelectItem>
                  {geo.status === 'granted' && (
                    <SelectItem value="cercanos">Más cercanos</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Lista — skeleton mientras carga, mensaje claro si vacío */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : error ? (
          <div className="py-16 text-center text-destructive text-sm">
            Error: {error}
            <div className="text-xs text-muted-foreground mt-2">
              Si dice "function fn_marketplace_listar does not exist", aplicá la migration 202605160400.
            </div>
          </div>
        ) : localesFiltrados.length === 0 ? (
          <div className="py-16 text-center">
            <Store className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-lg font-medium mb-1">
              {locales.length === 0 ? 'Sin restaurantes aún' : 'Sin resultados'}
            </h3>
            <p className="text-sm text-muted-foreground">
              {locales.length === 0
                ? 'Cuando los restaurantes activen su presencia en el marketplace van a aparecer acá.'
                : 'Probá con otra búsqueda o limpiá los filtros.'}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {localesPagina.map((local) => (
                <RestauranteCard key={local.id} local={local} distanciaKm={local.distanciaKm} />
              ))}
            </div>
            {totalPaginas > 1 && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setPagina((p) => Math.max(1, p - 1))}
                  disabled={pagina === 1}
                  className="px-3 h-8 rounded-md border border-border text-sm disabled:opacity-40"
                >
                  ← Anterior
                </button>
                <span className="text-sm text-muted-foreground tabular-nums">
                  Página {pagina} de {totalPaginas}
                </span>
                <button
                  type="button"
                  onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                  disabled={pagina === totalPaginas}
                  className="px-3 h-8 rounded-md border border-border text-sm disabled:opacity-40"
                >
                  Siguiente →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RestauranteCard({ local, distanciaKm }: { local: LocalMarketplace; distanciaKm: number | null }) {
  async function compartir(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Post 22-may noche: COMANDA vive en su URL propia (pase-comanda.vercel.app),
    // ya no embebida bajo /comanda-app/. El share apunta al origin actual + path
    // limpio. Si el user comparte desde el deploy nuevo, el link es directo.
    const url = `${window.location.origin}/tienda/${local.slug}`;
    const titulo = `${local.nombre} — pedí online`;
    if (navigator.share) {
      try { await navigator.share({ title: titulo, url }); } catch { /* user canceled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copiado al portapapeles');
    } catch {
      toast.error('No se pudo copiar');
    }
  }

  const cerrado = local.abierto_ahora === false;
  const tiempo = local.online_modo === 'delivery'
    ? local.tiempo_delivery_min
    : local.tiempo_retiro_min;

  return (
    <Link to={`/tienda/${local.slug}`} className="block group">
      <Card className={cn(
        'overflow-hidden transition-all group-hover:shadow-lg group-hover:-translate-y-1',
        cerrado && 'opacity-60',
      )}>
        {/* Foto / placeholder + badge abierto/cerrado */}
        <div className="aspect-[16/10] bg-gradient-to-br from-primary/20 to-accent flex items-center justify-center relative">
          {local.marketplace_foto_url ? (
            <img src={local.marketplace_foto_url} alt={local.nombre} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <Store className="h-12 w-12 text-primary/40" />
          )}
          {/* Badge abierto/cerrado en la esquina */}
          {local.abierto_ahora !== null && local.abierto_ahora !== undefined && (
            <div className={cn(
              'absolute top-2 left-2 text-[10px] font-bold px-2 py-1 rounded-full uppercase shadow',
              local.abierto_ahora
                ? 'bg-success text-success-foreground'
                : 'bg-destructive text-destructive-foreground',
            )}>
              {local.abierto_ahora ? '● Abierto' : '○ Cerrado'}
            </div>
          )}
          {/* Botón share en la esquina opuesta */}
          <button
            type="button"
            onClick={compartir}
            className="absolute top-2 right-2 h-8 w-8 rounded-full bg-background/90 backdrop-blur-sm hover:bg-background flex items-center justify-center shadow"
            aria-label="Compartir"
            title="Compartir / copiar link"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <CardContent className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold leading-tight">{local.nombre}</h3>
            <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5 group-hover:text-primary transition-colors" />
          </div>

          {local.marketplace_descripcion && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {local.marketplace_descripcion}
            </p>
          )}

          {/* Tags */}
          {local.marketplace_tags && local.marketplace_tags.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {local.marketplace_tags.slice(0, 3).map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {t}
                </span>
              ))}
              {local.marketplace_tags.length > 3 && (
                <span className="text-[10px] px-1.5 py-0.5 text-muted-foreground">
                  +{local.marketplace_tags.length - 3}
                </span>
              )}
            </div>
          )}

          {/* Indicadores */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
            {local.online_modo && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {local.online_modo === 'delivery' ? 'Envío' : local.online_modo === 'retiro' ? 'Retiro' : 'Pedidos'}
              </span>
            )}
            {tiempo && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                ~{tiempo} min
              </span>
            )}
            {distanciaKm != null && (
              <span className="flex items-center gap-1" title="Distancia desde tu ubicación">
                <Navigation className="h-3 w-3" />
                {distanciaKm < 1 ? `${(distanciaKm * 1000).toFixed(0)} m` : `${distanciaKm.toFixed(1)} km`}
              </span>
            )}
            {local.horario_hoy && cerrado && (
              <span className="ml-auto text-[10px] italic">Hoy: {local.horario_hoy}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function SkeletonCard() {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-[16/10] bg-muted animate-pulse" />
      <CardContent className="p-4 space-y-2">
        <div className="h-4 bg-muted animate-pulse rounded w-3/4" />
        <div className="h-3 bg-muted animate-pulse rounded w-full" />
        <div className="h-3 bg-muted animate-pulse rounded w-5/6" />
        <div className="flex gap-1 pt-1">
          <div className="h-4 bg-muted animate-pulse rounded w-12" />
          <div className="h-4 bg-muted animate-pulse rounded w-16" />
        </div>
      </CardContent>
    </Card>
  );
}
