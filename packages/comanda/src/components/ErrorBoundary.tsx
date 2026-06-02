import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// Detecta errores de chunk load fallido (build viejo en memoria del browser
// después de un deploy nuevo). Vite y otros bundlers generan hashes nuevos
// en cada deploy → el browser intenta cargar el chunk viejo que ya no existe
// en CDN → "Failed to fetch dynamically imported module" o similar.
//
// Bug Lucas 2026-06-02: tocó "Pedidos" en COMANDA después de varios deploys
// y vio "Failed to fetch dynamically imported module: PedidosHub-zi80tq1L.js"
// porque ese hash ya no existía. La solución es recargar la página — el
// nuevo index.html trae los hashes actuales.
//
// Patrón: detectar el error en getDerivedStateFromError + auto-reload con
// flag en sessionStorage para evitar loop infinito si el error persiste por
// otra razón (debería ser raro pero importante).
const CHUNK_LOAD_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Loading chunk \d+ failed/i,
  /Loading CSS chunk \d+ failed/i,
  /ChunkLoadError/i,
  /Importing a module script failed/i,
];

function isChunkLoadError(error: Error): boolean {
  const msg = error.message || '';
  return CHUNK_LOAD_ERROR_PATTERNS.some((re) => re.test(msg));
}

// ErrorBoundary clásico de React. Envuelve rutas críticas para que un
// error no rompa toda la app — muestra fallback amigable + botón Reintentar.
// Si detecta chunk load error, auto-recarga UNA vez (sin loop).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    // Auto-reload UNA VEZ si es chunk load error (build viejo en cache).
    // Flag en sessionStorage para evitar loop infinito.
    if (typeof window !== 'undefined' && isChunkLoadError(error)) {
      const alreadyReloaded = sessionStorage.getItem('comanda:chunk-reload-attempted');
      if (!alreadyReloaded) {
        sessionStorage.setItem('comanda:chunk-reload-attempted', String(Date.now()));
        // Reload sincrónico antes de que React monte el fallback
        window.location.reload();
        // El reload tarda, mostramos pantalla blanca por ~200ms — mejor que el error
        return { error: null };
      }
      // Ya intentamos reload y volvió a fallar — limpiar flag para próxima sesión
      // y mostrar fallback al user
      sessionStorage.removeItem('comanda:chunk-reload-attempted');
    }
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Telemetría / Sentry sería ideal acá. Por ahora console.
    console.error('ErrorBoundary capturó:', error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-destructive/10 mb-4">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Algo se rompió</h2>
            <p className="text-sm text-muted-foreground mb-1">
              No te preocupes, tu venta y datos están a salvo. Probá recargando
              la pantalla.
            </p>
            <p className="text-xs text-muted-foreground font-mono mb-6 bg-muted p-2 rounded">
              {error.message}
            </p>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={this.reset}>
                Reintentar
              </Button>
              <Button onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Recargar
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
