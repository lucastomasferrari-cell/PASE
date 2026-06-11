import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { tryReloadOnChunkError } from '@/lib/chunkLoadErrorHandler';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// ErrorBoundary clásico de React. Envuelve rutas críticas para que un
// error no rompa toda la app — muestra fallback amigable + botón Reintentar.
//
// Chunk load errors (build viejo en memoria después de un deploy nuevo,
// bug Lucas 2026-06-02 con PedidosHub): la detección + auto-reload viven
// en lib/chunkLoadErrorHandler (compartido con los listeners globales de
// main.tsx, que cubren los imports dinámicos fuera del render).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    // Auto-reload si es chunk load error (anti-loop: cooldown 60s en
    // sessionStorage). Si recargó, no montamos el fallback — pantalla
    // blanca por ~200ms es mejor que la pantalla de error.
    if (typeof window !== 'undefined' && tryReloadOnChunkError(error)) {
      return { error: null };
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
