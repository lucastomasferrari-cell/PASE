import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Banner que aparece SOLO en mobile/tablet chica + dentro del POS shell.
// Sugiere al mozo entrar a /pos/handheld (vista mobile-first 3 cols + flujo
// "mesa → catálogo → mandar a cocina") en lugar de pelearse con la vista
// tablet apretada en el celu.
//
// Persiste dismiss en localStorage para no agotar al usuario que ya eligió.
// Reset: borrar la key 'comanda.handheld-banner-dismissed'.

const STORAGE_KEY = 'comanda.handheld-banner-dismissed';
const MOBILE_BREAKPOINT_PX = 768;

export function MobileModoMozoBanner() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // No mostrar si ya está en HandheldView
    if (location.pathname.startsWith('/pos/handheld')) {
      setVisible(false);
      return;
    }
    // No mostrar si ya fue dismissed
    if (sessionStorage.getItem(STORAGE_KEY)) {
      setVisible(false);
      return;
    }
    // Solo mobile/tablet chica
    function check() {
      setVisible(window.innerWidth < MOBILE_BREAKPOINT_PX);
    }
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [location.pathname]);

  function dismiss() {
    sessionStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-3 left-3 right-3 z-50 bg-primary text-primary-foreground rounded-xl shadow-lg p-3 flex items-center gap-3 animate-in slide-in-from-bottom-3">
      <Smartphone className="h-5 w-5 shrink-0" />
      <div className="flex-1 min-w-0 text-sm">
        <div className="font-semibold leading-tight">¿Estás comandando en la mesa?</div>
        <div className="text-xs opacity-90 mt-0.5">
          Probá Modo Mozo — diseñado para el celu.
        </div>
      </div>
      <Button asChild size="sm" variant="secondary" className="shrink-0">
        <Link to="/pos/handheld" onClick={dismiss}>
          Entrar
        </Link>
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Cerrar"
        className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-primary-foreground/10"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
