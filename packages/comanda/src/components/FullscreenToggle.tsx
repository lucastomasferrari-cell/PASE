import { useEffect, useState, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Botón para entrar/salir de modo pantalla completa del navegador.
// Útil en tablet POS: oculta URL bar + tabs + bottom nav del browser para
// que la app ocupe todo el viewport y se vea como app nativa.
//
// Fullscreen API es estándar pero algunos browsers móviles (Safari iOS) la
// limitan. En esos casos el ícono igual aparece pero el clic no hace nada
// — la alternativa es instalar como PWA (manifest standalone).

export function FullscreenToggle({ className }: { className?: string }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    // Detectar soporte. iOS Safari no soporta Fullscreen API en iPhone
    // (sí en iPad parcialmente). Si no hay método, ocultamos el botón.
    const doc = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    setSupported(
      typeof document.fullscreenEnabled === 'boolean'
        ? document.fullscreenEnabled
        : Boolean(doc.webkitRequestFullscreen),
    );

    function onChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggle = useCallback(async () => {
    const doc = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    const docExit = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
    };
    try {
      if (!document.fullscreenElement) {
        if (doc.requestFullscreen) await doc.requestFullscreen();
        else if (doc.webkitRequestFullscreen) await doc.webkitRequestFullscreen();
      } else {
        if (docExit.exitFullscreen) await docExit.exitFullscreen();
        else if (docExit.webkitExitFullscreen) await docExit.webkitExitFullscreen();
      }
    } catch {
      // Algunos navegadores tiran error si no hay user gesture o políticas
      // — silencioso, el botón vuelve a estado original.
    }
  }, []);

  if (!supported) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={toggle}
      title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
      aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
      className={className}
    >
      {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </Button>
  );
}
