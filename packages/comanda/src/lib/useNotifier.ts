import { useCallback, useEffect, useRef, useState } from 'react';

// Hook para alertar al cajero/encargado cuando entra un pedido nuevo (Rappi,
// PedidosYa, MP). Combina:
//   - Beep generado vía WebAudio (sin asset, no requiere fetch)
//   - Browser Notification (si el usuario otorgó permiso)
//
// Se persiste en localStorage si el usuario "muteó" alertas para esta sesión.

const MUTE_KEY = 'comanda_alerts_muted';

export type NotifPermState = 'default' | 'granted' | 'denied' | 'unsupported';

export function useNotifier() {
  const [muted, setMutedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(MUTE_KEY) === '1';
  });
  const [permState, setPermState] = useState<NotifPermState>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission as NotifPermState;
  });
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // Re-leer permiso en cada mount por si el user lo cambió en site settings.
    if ('Notification' in window) setPermState(Notification.permission as NotifPermState);
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (m) localStorage.setItem(MUTE_KEY, '1');
    else localStorage.removeItem(MUTE_KEY);
  }, []);

  const askPermission = useCallback(async () => {
    if (!('Notification' in window)) return 'unsupported' as NotifPermState;
    const r = await Notification.requestPermission();
    setPermState(r as NotifPermState);
    return r as NotifPermState;
  }, []);

  // Beep de 2 tonos (alto-bajo) ~ 350ms. Suena claro sin asustar.
  const beep = useCallback(() => {
    if (muted) return;
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      const now = ctx.currentTime;
      const playTone = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(0.25, now + start + 0.01);
        gain.gain.linearRampToValueAtTime(0, now + start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur);
      };
      playTone(880, 0, 0.18);
      playTone(660, 0.20, 0.18);
    } catch {
      // Audio context bloqueado o no disponible — degradamos silencioso.
    }
  }, [muted]);

  const notify = useCallback((titulo: string, body: string) => {
    beep();
    if (muted) return;
    if (permState === 'granted' && document.visibilityState !== 'visible') {
      try {
        new Notification(titulo, { body, tag: 'comanda-pedido', renotify: true } as NotificationOptions);
      } catch {
        // Silent fail si el browser rechaza.
      }
    }
  }, [beep, muted, permState]);

  return { notify, beep, muted, setMuted, permState, askPermission };
}
