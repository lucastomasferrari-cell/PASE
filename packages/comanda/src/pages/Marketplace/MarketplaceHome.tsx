import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, MapPin, ExternalLink, Store } from 'lucide-react';
import { listMarketplaceLocales, type LocalMarketplace } from '@/services/marketplaceService';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/utils';

// Marketplace público — feed cross-tenant de locales que activaron
// visible_marketplace. NO requiere auth. El usuario navega, descubre
// restaurantes y entra a la tienda online (/tienda/<slug>) para pedir.
//
// Es la versión inicial (estructura): falta geolocalización + rating +
// filtros por radio. Por ahora: search por nombre + chips de tags +
// grid de cards.

export function MarketplaceHome() {
  const [locales, setLocales] = useState<LocalMarketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tagFiltro, setTagFiltro] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);

  useEffect(() => {
    listMarketplaceLocales().then(({ data, error: err }) => {
      if (err) setError(err);
      setLocales(data);
      setLoading(false);
    });
  }, []);

  // Tags únicos para chips de filtro
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const l of locales) {
      for (const t of l.marketplace_tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [locales]);

  const localesFiltrados = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return locales.filter((l) => {
      if (q && !l.nombre.toLowerCase().includes(q) && !(l.marketplace_descripcion ?? '').toLowerCase().includes(q)) {
        return false;
      }
      if (tagFiltro && !(l.marketplace_tags ?? []).includes(tagFiltro)) {
        return false;
      }
      return true;
    });
  }, [locales, debouncedSearch, tagFiltro]);

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
        {/* Tags de filtro */}
        {tags.length > 0 && (
          <div className="mb-6 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setTagFiltro(null)}
              className={cn(
                'px-3 h-8 rounded-full text-sm transition-colors',
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
                  'px-3 h-8 rounded-full text-sm transition-colors',
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

        {/* Lista */}
        {loading ? (
          <div className="py-16 text-center text-muted-foreground">Cargando restaurantes…</div>
        ) : error ? (
          <div className="py-16 text-center text-destructive text-sm">
            Error: {error}
            <div className="text-xs text-muted-foreground mt-2">
              Si dice "function fn_marketplace_listar does not exist", la migration
              202605151970 todavía no se aplicó.
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {localesFiltrados.map((local) => (
              <RestauranteCard key={local.id} local={local} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RestauranteCard({ local }: { local: LocalMarketplace }) {
  return (
    <Link to={`/tienda/${local.slug}`} className="block group">
      <Card className="overflow-hidden transition-all group-hover:shadow-lg group-hover:-translate-y-1">
        {/* Foto / placeholder */}
        <div className="aspect-[16/10] bg-gradient-to-br from-primary/20 to-accent flex items-center justify-center relative">
          {local.marketplace_foto_url ? (
            <img src={local.marketplace_foto_url} alt={local.nombre} className="w-full h-full object-cover" />
          ) : (
            <Store className="h-12 w-12 text-primary/40" />
          )}
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
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
