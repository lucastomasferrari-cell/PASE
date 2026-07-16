import { useEffect, useState, useCallback } from 'react';

// Hook para el install prompt de PWA (Chrome/Edge/Samsung Internet).
//
// Chrome dispara `beforeinstallprompt` cuando detecta que la web es
// instalable como PWA y el usuario NO la instaló todavía. El evento
// trae un `.prompt()` que abre el diálogo nativo del sistema.
//
// iOS Safari NO soporta este evento — Apple obliga al usuario a ir a
// Compartir → Agregar a inicio. En ese caso `canInstall` queda false.
//
// Uso:
//   const { canInstall, install, isInstalled } = useInstallPrompt();
//   if (canInstall) return <button onClick={install}>Instalar app</button>;

// Tipo estándar (no viene en las DOM lib types por default).
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // Si ya está corriendo en modo standalone, la app está instalada.
    // media query estándar; en iOS Safari standalone es navigator.standalone.
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as { standalone?: boolean }).standalone === true;
    setIsInstalled(standalone);
  }, []);

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault(); // evita que Chrome muestre su banner automático
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      setIsInstalled(true);
      setDeferredPrompt(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return { installed: false, reason: 'no-prompt' as const };
    await deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return {
      installed: result.outcome === 'accepted',
      reason: result.outcome,
    };
  }, [deferredPrompt]);

  return {
    canInstall: deferredPrompt !== null && !isInstalled,
    install,
    isInstalled,
  };
}
