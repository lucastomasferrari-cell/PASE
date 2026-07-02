import { db } from './supabase';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushPermissionStatus = 'default' | 'granted' | 'denied' | 'unsupported';

export function getPushPermissionStatus(): PushPermissionStatus {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  return Notification.permission as PushPermissionStatus;
}

export async function isCurrentlySubscribed(): Promise<boolean> {
  if (getPushPermissionStatus() !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const { data } = await db().from('admin_push_subscriptions')
      .select('id')
      .eq('endpoint', sub.endpoint)
      .limit(1);
    if (!data || data.length === 0) {
      try { await sub.unsubscribe(); } catch { /* noop */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function subscribeToPush(deviceLabel?: string): Promise<{ ok: boolean; error?: string }> {
  if (!VAPID_PUBLIC_KEY) {
    return { ok: false, error: 'VAPID public key no configurada (VITE_VAPID_PUBLIC_KEY)' };
  }
  if (getPushPermissionStatus() === 'unsupported') {
    return { ok: false, error: 'Tu navegador no soporta notificaciones push' };
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return { ok: false, error: 'Permiso denegado' };
  }

  let sub: PushSubscription;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  } catch (e) {
    return { ok: false, error: `Error suscribiendo: ${e instanceof Error ? e.message : String(e)}` };
  }

  const subJson = sub.toJSON();
  const p256dh = subJson.keys?.p256dh;
  const auth = subJson.keys?.auth;
  if (!p256dh || !auth) {
    return { ok: false, error: 'Faltan claves de cifrado en la suscripción' };
  }

  const { data: usuario } = await db().from('usuarios')
    .select('id')
    .eq('auth_id', (await db().auth.getUser()).data.user?.id)
    .single();
  if (!usuario) {
    return { ok: false, error: 'Usuario no encontrado' };
  }

  const { error: insertErr } = await db().from('admin_push_subscriptions')
    .upsert({
      user_id: usuario.id,
      endpoint: sub.endpoint,
      p256dh,
      auth,
      device_label: deviceLabel || `IG-Bot ${navigator.platform} — ${navigator.userAgent.substring(0, 80)}`,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id,endpoint' });

  if (insertErr) {
    return { ok: false, error: `Error guardando suscripción: ${insertErr.message}` };
  }

  return { ok: true };
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await db().from('admin_push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
