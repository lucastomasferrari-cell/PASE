import { useEffect, useState } from 'react';
import { Outlet, useParams, Link, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { getLocalPorSlug, type LocalPublico } from '@/services/tiendaService';
import { Skeleton } from '@/components/ui/skeleton';

// Layout público para la tienda online. NO usa ProtectedShell ni AuthGate.
// Carga el local por slug y lo expone via context para los hijos.

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

  if (notFound) return <TiendaNotFound slug={localSlug ?? ''} />;
  if (loading || !local) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto p-4 space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Toaster position="top-center" richColors closeButton />
      <header className="bg-primary text-primary-foreground sticky top-0 z-30 shadow">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{local.nombre}</h1>
            {local.direccion && (
              <p className="text-xs text-primary-foreground/80 truncate">{local.direccion}</p>
            )}
          </div>
          <Link
            to={`/tienda/${local.slug}/seguimiento`}
            className="text-xs underline whitespace-nowrap opacity-90 hover:opacity-100"
          >
            Mi pedido
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <Outlet context={{ local } satisfies TiendaCtx} />
      </main>
      <footer className="border-t border-border py-4 px-4 text-center text-[10px] text-muted-foreground">
        Powered by COMANDA · {local.instagram && <a className="underline" href={`https://instagram.com/${local.instagram.replace(/^@/, '')}`} target="_blank" rel="noreferrer">@{local.instagram.replace(/^@/, '')}</a>}
      </footer>
    </div>
  );
}

function TiendaNotFound({ slug }: { slug: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center bg-background">
      <div className="max-w-sm">
        <div className="text-5xl mb-3">🤔</div>
        <h1 className="text-lg font-semibold">Local no encontrado</h1>
        <p className="text-sm text-muted-foreground mt-2">
          No existe una tienda con la dirección <code className="px-1 py-0.5 rounded bg-muted text-xs">/{slug}</code> o todavía no está activa.
        </p>
        <p className="text-xs text-muted-foreground mt-3">Probá pedirle al local el link correcto.</p>
      </div>
    </div>
  );
}

// Helper de redirect cuando se entra a /tienda sin slug.
export function TiendaIndexRedirect() {
  return <Navigate to="/" replace />;
}
