import { useEffect, useState } from 'react';
import { Outlet, useParams, Link, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ChevronDown } from 'lucide-react';
import { getLocalPorSlug, type LocalPublico } from '@/services/tiendaService';
import { Skeleton } from '@/components/ui/skeleton';
import { tiendaCarritoBadge } from './tiendaCarritoBadge';

// Layout público para la tienda online. NO usa ProtectedShell ni AuthGate.
// Carga el local por slug y lo expone via context para los hijos.
//
// Sprint 5 (estética V2): header limpio Roc N Ramen-style con logo,
// nombre, "More", "Sign in" (placeholders), carrito badge. Sin coral
// en el header — solo en CTAs de acción.

export interface TiendaCtx {
  local: LocalPublico;
}

export function TiendaLayout() {
  const { localSlug } = useParams<{ localSlug: string }>();
  const [local, setLocal] = useState<LocalPublico | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!localSlug) return;
    let cancelled = false;
    setLoading(true);
    getLocalPorSlug(localSlug).then(({ data }) => {
      if (cancelled) return;
      if (!data) setNotFound(true); else setLocal(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [localSlug]);

  // SEO básico: title dinámico del documento. Open Graph queda como
  // deuda — react-helmet-async no está instalado y no agregamos dep.
  useEffect(() => {
    if (!local) return;
    const prev = document.title;
    document.title = `${local.nombre} · Pedí online`;
    return () => { document.title = prev; };
  }, [local]);

  if (notFound) return <TiendaNotFound slug={localSlug ?? ''} />;
  if (loading || !local) {
    return (
      <div className="min-h-screen bg-white">
        <header className="sticky top-0 bg-white border-b border-gray-200 px-5 py-3">
          <Skeleton className="h-8 w-40" />
        </header>
        <div className="max-w-6xl mx-auto p-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-foreground flex flex-col">
      <Toaster position="top-center" richColors closeButton />
      <Header local={local} />
      <main className="flex-1">
        <Outlet context={{ local } satisfies TiendaCtx} />
      </main>
      <footer className="border-t border-gray-100 py-6 px-5 text-center text-xs text-foreground/50">
        Powered by COMANDA{' '}
        {local.instagram && (
          <>
            ·{' '}
            <a
              className="underline hover:text-foreground/70"
              href={`https://instagram.com/${local.instagram.replace(/^@/, '')}`}
              target="_blank"
              rel="noreferrer"
            >
              @{local.instagram.replace(/^@/, '')}
            </a>
          </>
        )}
      </footer>
    </div>
  );
}

function Header({ local }: { local: LocalPublico }) {
  const inicial = local.nombre?.[0]?.toUpperCase() ?? '?';
  // Badge del carrito leído desde un store mini (independiente del slug
  // para evitar acoplar TiendaLayout al carritoStore — el badge solo
  // visualiza el N actual y deja el click handling al child page).
  const count = tiendaCarritoBadge.useCount();

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-gray-100">
      <div className="max-w-6xl mx-auto px-5 py-3 flex items-center justify-between gap-4">
        <Link to={`/tienda/${local.slug}`} className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 flex-shrink-0 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-medium text-sm">
            {inicial}
          </div>
          <span className="font-medium truncate">{local.nombre}</span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3 text-sm text-foreground/70">
          <button
            type="button"
            className="hidden sm:inline-flex items-center gap-1 px-2 py-1 hover:text-foreground transition-colors"
            disabled
            title="Próximamente"
          >
            More <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="hidden sm:inline px-2 py-1 hover:text-foreground transition-colors"
            disabled
            title="Próximamente"
          >
            Sign in
          </button>
          <Link
            to={`/tienda/${local.slug}/seguimiento`}
            className="px-2 py-1 text-foreground/70 hover:text-foreground transition-colors"
          >
            Mi pedido
          </Link>
          <button
            type="button"
            onClick={() => tiendaCarritoBadge.openCart()}
            className="relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-gray-50 transition-colors"
            aria-label={`Carrito (${count})`}
          >
            <CartIcon />
            <span className="hidden sm:inline">Carrito</span>
            {count > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {count}
              </span>
            )}
          </button>
        </nav>
      </div>
    </header>
  );
}

function CartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function TiendaNotFound({ slug }: { slug: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center bg-white">
      <div className="max-w-sm">
        <div className="text-5xl mb-3">🤔</div>
        <h1 className="text-xl font-medium text-foreground">Local no encontrado</h1>
        <p className="text-sm text-foreground/60 mt-3">
          No existe una tienda con la dirección{' '}
          <code className="px-1.5 py-0.5 rounded bg-gray-100 text-xs">/{slug}</code>{' '}
          o todavía no está activa.
        </p>
        <p className="text-sm text-foreground/50 mt-3">Probá pedirle al local el link correcto.</p>
      </div>
    </div>
  );
}

// Helper de redirect cuando se entra a /tienda sin slug.
export function TiendaIndexRedirect() {
  return <Navigate to="/" replace />;
}
