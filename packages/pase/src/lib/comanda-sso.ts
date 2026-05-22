// Helper para abrir COMANDA con SSO bridge.
//
// COMANDA vive en URL propia desde 21-may noche. Como Supabase Auth no
// comparte cookie cross-domain, sin bridge el staff tendría que loguearse
// 2 veces. Este helper:
//   1. Lee la sesión actual de Supabase Auth (access + refresh tokens).
//   2. La cambia por una fresca contra el endpoint /api/auth-bridge del bot.
//   3. Abre COMANDA con los tokens en query string (?at=... &rt=...).
//   4. COMANDA detecta los tokens en main.tsx y hace db.auth.setSession.
//
// Fallback: si VITE_COMANDA_URL no está configurada O el bridge falla,
// abre /comanda-app/ (la versión embedded en PASE — mismo dominio, no
// hace falta SSO porque comparte cookie de auth).

import { db } from "./supabase";

const COMANDA_URL = (import.meta.env.VITE_COMANDA_URL as string | undefined)?.trim() || "";
const BOT_URL = (import.meta.env.VITE_IG_BOT_URL as string | undefined)?.trim() || "https://pase-instagram-bot.vercel.app";

/**
 * Abre COMANDA en una nueva tab. Si VITE_COMANDA_URL apunta a otro dominio,
 * usa el bridge SSO para que el user no tenga que loguearse de nuevo.
 *
 * @param path Ruta dentro de COMANDA (default "/pos"). Sin slash inicial.
 */
export async function abrirComanda(path: string = "/"): Promise<void> {
  // Si COMANDA_URL no está configurada o apunta a /comanda-app (embedded),
  // abrimos directo — no hace falta SSO porque comparte cookie.
  const targetUrl = COMANDA_URL && !COMANDA_URL.includes("/comanda-app")
    ? COMANDA_URL
    : "/comanda-app";

  const isExternal = targetUrl.startsWith("http") && !targetUrl.startsWith(window.location.origin);

  if (!isExternal) {
    // Same-origin → abrir directo, la cookie de Supabase Auth viaja.
    window.open(`${targetUrl}${path}`, "_blank", "noopener");
    return;
  }

  // Cross-domain → pedir tokens frescos al bridge.
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      alert("Sesión expirada. Volvé a loguearte.");
      return;
    }

    const r = await fetch(`${BOT_URL}/api/auth-bridge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token || !data.refresh_token) {
      alert(`Error abriendo COMANDA: ${data.error || "BRIDGE_FAILED"}`);
      return;
    }

    const url = new URL(`${targetUrl}${path}`);
    url.searchParams.set("at", data.access_token);
    url.searchParams.set("rt", data.refresh_token);
    window.open(url.toString(), "_blank", "noopener");
  } catch (e) {
    alert(`Error abriendo COMANDA: ${e instanceof Error ? e.message : String(e)}`);
  }
}
