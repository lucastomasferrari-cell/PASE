// Helper para Web Push Notifications.
//
// Patrón:
//   1. Pedir permiso al user (Notification.requestPermission)
//   2. Suscribir el browser al PushManager con la VAPID public key
//   3. Persistir la suscripción en admin_push_subscriptions
//   4. El server (auto-fix-bug.yml o bot IG) lee esa tabla y manda push
//      cuando hay algo que avisar.

import { db } from "./supabase";

// VAPID public key — corresponde a la VAPID_PUBLIC_KEY del server.
// Inyectada al build vía VITE_VAPID_PUBLIC_KEY. Si no está, push deshabilitado.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushPermissionStatus = "default" | "granted" | "denied" | "unsupported";

export function getPushPermissionStatus(): PushPermissionStatus {
  if (typeof window === "undefined") return "unsupported";
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }
  return Notification.permission as PushPermissionStatus;
}

/**
 * Devuelve true si el browser está suscrito Y la suscripción está persistida
 * en admin_push_subscriptions de este user. Si el sub del browser local no
 * coincide con la DB (porque el server detectó 410 Gone y la borró, o porque
 * Chrome rotó el endpoint), devuelve false → el toggle muestra "Desactivado"
 * y el user vuelve a activar (re-suscribe).
 */
export async function isCurrentlySubscribed(): Promise<boolean> {
  if (getPushPermissionStatus() !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const { data } = await db.from("admin_push_subscriptions")
      .select("id")
      .eq("endpoint", sub.endpoint)
      .limit(1);
    if (!data || data.length === 0) {
      // El browser cree que está suscrito pero la DB no tiene la sub —
      // probablemente expiró y el server la borró por 410 Gone. Limpiar
      // el sub local para que el user pueda re-suscribirse.
      try { await sub.unsubscribe(); } catch { /* noop */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Pide permiso al user, suscribe al PushManager y persiste en DB.
 * Devuelve true si quedó suscrito correctamente.
 */
export async function subscribeToPush(deviceLabel?: string): Promise<{ ok: boolean; error?: string }> {
  if (!VAPID_PUBLIC_KEY) {
    return { ok: false, error: "VAPID public key no configurada (VITE_VAPID_PUBLIC_KEY)" };
  }
  if (getPushPermissionStatus() === "unsupported") {
    return { ok: false, error: "Tu navegador no soporta notificaciones push" };
  }

  // 1. Permiso
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { ok: false, error: "Permiso denegado" };
  }

  // 2. Suscribir al PushManager
  let sub: PushSubscription;
  try {
    const reg = await navigator.serviceWorker.ready;
    // Si ya hay subscripción previa con otra VAPID key, la desuscribimos.
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
    }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  } catch (e) {
    return { ok: false, error: `Error suscribiendo: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 3. Persistir en DB (upsert por endpoint).
  const subJson = sub.toJSON();
  const p256dh = subJson.keys?.p256dh;
  const auth = subJson.keys?.auth;
  if (!p256dh || !auth) {
    return { ok: false, error: "Faltan claves de cifrado en la suscripción" };
  }

  const { data: usuario } = await db.from("usuarios")
    .select("id")
    .eq("auth_id", (await db.auth.getUser()).data.user?.id)
    .single();
  if (!usuario) {
    return { ok: false, error: "Usuario no encontrado en tabla usuarios" };
  }

  const { error: insertErr } = await db.from("admin_push_subscriptions")
    .upsert({
      user_id: usuario.id,
      endpoint: sub.endpoint,
      p256dh,
      auth,
      device_label: deviceLabel || `${navigator.platform} — ${navigator.userAgent.substring(0, 80)}`,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "user_id,endpoint" });

  if (insertErr) {
    return { ok: false, error: `Error guardando suscripción: ${insertErr.message}` };
  }

  return { ok: true };
}

/**
 * Desuscribir el browser actual.
 */
export async function unsubscribeFromPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await db.from("admin_push_subscriptions")
        .delete()
        .eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
