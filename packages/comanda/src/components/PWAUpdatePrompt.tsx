import { useEffect } from 'react';
// @ts-expect-error virtual:pwa-register/react es generado por vite-plugin-pwa en build.
// No tiene types públicos pero el runtime existe siempre que VitePWA esté activo.
import { useRegisterSW } from 'virtual:pwa-register/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

/**
 * Detecta cuando hay una versión nueva del bundle deployado y muestra un
 * toast persistente con botón "Actualizar ahora".
 *
 * Por qué no auto-reload: si un mozo está a mitad de cobrar un ticket y
 * el browser se recarga solo, pierde el carrito. Mejor que el usuario
 * decida cuándo es seguro recargar (después de cobrar, antes de un
 * nuevo turno, etc.).
 *
 * Por qué toast persistente: si el mozo está cobrando y aparece el toast,
 * lo ignora y sigue. Cuando termina y queda free, le da click. Si fuera
 * un dialog modal le rompería el flow.
 *
 * En desarrollo (dev server) no se monta el SW, así que `needRefresh`
 * nunca se dispara — el componente es seguro de tener siempre montado.
 */
export function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      console.log('[PWA] SW registrado:', swUrl);
      // Chequeo periódico de actualización: sin esto, el SW solo busca
      // versión nueva al cargar la página. Con esto, si dejás la pestaña
      // abierta y deployamos, el toast "Nueva versión disponible" aparece
      // en ~1 min sin necesidad de recargar a mano.
      if (registration) {
        setInterval(() => {
          void registration.update();
        }, 60_000);
      }
    },
    onRegisterError(err: unknown) {
      console.warn('[PWA] error al registrar SW:', err);
    },
  });

  useEffect(() => {
    if (!needRefresh) return;
    const id = toast.message('Nueva versión disponible', {
      description: 'Hay una actualización lista. Recargá cuando puedas para verla.',
      duration: Infinity,  // persiste hasta que el user actúe
      action: (
        <Button
          size="sm"
          onClick={async () => {
            await updateServiceWorker(true);  // skipWaiting + reload
          }}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Actualizar
        </Button>
      ),
      onDismiss: () => setNeedRefresh(false),
    });
    return () => { toast.dismiss(id); };
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
