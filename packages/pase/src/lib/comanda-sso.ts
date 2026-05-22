// Helper para abrir COMANDA con SSO bridge.
//
// COMANDA vive en URL propia desde 22-may noche (deploy `pase-comanda.vercel.app`).
// Como Supabase Auth no comparte cookie cross-domain, sin bridge el staff
// tendría que loguearse 2 veces. Este helper:
//   1. Lee la sesión actual de Supabase Auth (access + refresh tokens).
//   2. La cambia por una fresca contra el endpoint /api/auth-bridge del bot.
//   3. Abre COMANDA con los tokens en query string (?at=... &rt=...).
//   4. COMANDA detecta los tokens en main.tsx y hace db.auth.setSession.
//
// El embed `/comanda-app/` fue eliminado el 22-may noche en el cleanup post-
// SSO bridge. Si VITE_COMANDA_URL no está configurada (típico en dev local),
// el botón alerta al user en vez de fallar silencioso.

import { db } from "./supabase";

const COMANDA_URL = (import.meta.env.VITE_COMANDA_URL as string | undefined)?.trim() || "";
const BOT_URL = (import.meta.env.VITE_IG_BOT_URL as string | undefined)?.trim() || "https://pase-instagram-bot.vercel.app";

/**
 * Abre COMANDA en una nueva tab con SSO automático.
 *
 * @param path Ruta dentro de COMANDA (default "/"). Sin slash inicial.
 */
export async function abrirComanda(path: string = "/"): Promise<void> {
  if (!COMANDA_URL) {
    alert(
      "VITE_COMANDA_URL no configurada. En prod debería apuntar a https://pase-comanda.vercel.app. " +
      "En dev local, seteala en .env.local para que el botón funcione.",
    );
    return;
  }

  const isExternal = COMANDA_URL.startsWith("http") && !COMANDA_URL.startsWith(window.location.origin);

  if (!isExternal) {
    // Same-origin (raro pero soportado: dev con proxy) → abrir directo,
    // la cookie de Supabase Auth viaja.
    window.open(`${COMANDA_URL}${path}`, "_blank", "noopener");
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

    const url = new URL(`${COMANDA_URL}${path}`);
    url.searchParams.set("at", data.access_token);
    url.searchParams.set("rt", data.refresh_token);
    window.open(url.toString(), "_blank", "noopener");
  } catch (e) {
    alert(`Error abriendo COMANDA: ${e instanceof Error ? e.message : String(e)}`);
  }
}
