// Web Push helpers para el Admin Console.
//
// Flow de suscripción:
//   1. El user clickea "Activar notificaciones".
//   2. Pedimos permiso (Notification.requestPermission).
//   3. Si OK, registramos suscripción con la VAPID public key.
//   4. Persistimos endpoint + keys en admin_push_subscriptions.
//
// El SW recibe el push y muestra notification (manejo en main.tsx /
// public/sw-push.js).

import { db } from './supabase';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export interface PushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

export function getPushState(): PushState {
  if (typeof window === 'undefined') {
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  const supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  return {
    supported,
    permission: supported ? Notification.permission : 'unsupported',
    subscribed: false, // se calcula con isSubscribed() async
  };
}

export async function isSubscribed(): Promise<boolean> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

// Base64-URL → Uint8Array (formato que pushManager.subscribe espera).
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function subscribe(userId: number): Promise<{ ok: boolean; error?: string }> {
  if (!VAPID_PUBLIC_KEY) {
    return { ok: false, error: 'VITE_VAPID_PUBLIC_KEY no configurada. Pidiéndole a Lucas que la setee en Vercel.' };
  }

  if (Notification.permission === 'denied') {
    return { ok: false, error: 'Permiso de notificaciones bloqueado. Habilitalo desde el menú del navegador (lock icon → permisos).' };
  }

  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'Permiso denegado.' };
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, error: 'Suscripción incompleta (faltan keys).' };
    }

    // Upsert en DB (UNIQUE constraint en (user_id, endpoint) deduplica).
    const deviceLabel = detectDeviceLabel();
    const { error } = await db.from('admin_push_subscriptions').upsert({
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      device_label: deviceLabel,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id,endpoint' });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function unsubscribe(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: true };

    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    const { error } = await db.from('admin_push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Mini heuristic para etiquetar el dispositivo. Útil cuando Lucas ve la
// lista de sus subscripciones y necesita identificar cuál corresponde a
// cuál celu.
function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  let device = 'Dispositivo';
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Mac OS X/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows PC';
  else if (/Linux/.test(ua)) device = 'Linux';
  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${device} (${browser})` : device;
}
