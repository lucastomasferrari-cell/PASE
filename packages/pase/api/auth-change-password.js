// /api/auth-change-password — cambiar contraseña del user logueado
//
// Reemplaza al flow client-side de 2 pasos que sufría race conditions y
// se colgaba indefinidamente (bug reportado 27-may por Lucas en Malita).
//
// El user manda su JWT actual en Authorization. El endpoint:
//   1. Valida el JWT con SUPABASE_SERVICE_KEY → obtiene auth_id.
//   2. Cambia el password en Supabase Auth via Admin API (NO requiere
//      que la session del cliente sea válida — Admin lo hace por nosotros).
//   3. Marca usuarios.password_temporal=false con service_key (bypass RLS).
//   4. Devuelve códigos de error específicos para que el frontend muestre
//      mensajes claros en español.
//
// Por qué esto resuelve los bugs:
// - Atómico server-side: si falla algo, devuelve error claro. Si todo OK,
//   ambos cambios pasan. Sin race conditions con onAuthStateChange.
// - No depende de la session client-side: si los tokens están revocados
//   pero el JWT actual todavía es válido (cosa común porque la revocación
//   afecta el refresh, no el access todavía no vencido), funciona igual.
// - Devuelve códigos `SAME_PASSWORD`, `WEAK_PASSWORD`, etc. en lugar de
//   strings en inglés.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "NO_AUTH_HEADER" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return res.status(401).json({ error: "NO_AUTH_HEADER" });

  // Vercel ya parsea JSON cuando Content-Type es application/json.
  // Defensive: si llega como string, parseamos.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const newPassword = body?.newPassword;
  if (typeof newPassword !== "string") {
    return res.status(400).json({ error: "BAD_REQUEST" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "PASSWORD_TOO_SHORT" });
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SVC) {
    // eslint-disable-next-line no-console
    console.error("[auth-change-password] Missing env SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return res.status(500).json({ error: "MISSING_ENV" });
  }

  const admin = createClient(SUPA_URL, SVC, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Paso 1 — Validar JWT y obtener auth_id.
  const { data: userData, error: getUserErr } = await admin.auth.getUser(jwt);
  if (getUserErr || !userData?.user) {
    return res.status(401).json({
      error: "JWT_INVALID",
      detail: getUserErr?.message || "El JWT no es válido o venció",
    });
  }
  const authId = userData.user.id;

  // Paso 2 — Cambiar password via Admin API.
  const { error: updErr } = await admin.auth.admin.updateUserById(authId, {
    password: newPassword,
  });
  if (updErr) {
    const msg = (updErr.message || "").toLowerCase();
    if (updErr.code === "same_password" || msg.includes("different from the old")) {
      return res.status(422).json({ error: "SAME_PASSWORD" });
    }
    if (updErr.code === "weak_password" || msg.includes("weak password")) {
      return res.status(422).json({ error: "WEAK_PASSWORD", detail: updErr.message });
    }
    // eslint-disable-next-line no-console
    console.error("[auth-change-password] updateUserById error:", updErr);
    return res.status(500).json({
      error: "UPDATE_FAILED",
      detail: updErr.message,
    });
  }

  // Paso 3 — Marcar password_temporal=false (service_key bypasea RLS).
  const { error: dbErr } = await admin
    .from("usuarios")
    .update({ password_temporal: false })
    .eq("auth_id", authId);
  if (dbErr) {
    // El password YA cambió en auth.users. No podemos hacer rollback limpio.
    // Devolvemos warning específico para que el frontend muestre instrucción.
    // eslint-disable-next-line no-console
    console.error("[auth-change-password] usuarios UPDATE error:", dbErr);
    return res.status(500).json({
      error: "FLAG_UPDATE_FAILED",
      detail: dbErr.message,
      passwordChanged: true,
    });
  }

  return res.status(200).json({ ok: true });
}
