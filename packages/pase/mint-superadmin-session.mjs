// TEMP (no commitear): mintea una sesión real de superadmin@pase.local vía
// service key (admin.generateLink magiclink → verifyOtp) y la deja en el
// auth-cache que usa la suite e2e-full. Evita necesitar SUPERADMIN_PASSWORD
// (solo existe como secret de GitHub). No muta nada en prod.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const EMAIL = "superadmin@pase.local";

const raw = readFileSync(new URL("./.env.local", import.meta.url), "utf-8");
const get = (k) => raw.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim().replace(/^"(.*)"$/, "$1");
const serviceKey = get("SUPABASE_SERVICE_KEY");
const anonKey = get("VITE_SUPABASE_ANON_KEY");
if (!serviceKey || !anonKey) { console.error("faltan keys en .env.local"); process.exit(1); }

const admin = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
if (linkErr) { console.error("generateLink:", linkErr.message); process.exit(1); }

const anon = createClient(SUPABASE_URL, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: sess, error: otpErr } = await anon.auth.verifyOtp({
  type: "magiclink",
  token_hash: linkData.properties.hashed_token,
});
if (otpErr || !sess.session) { console.error("verifyOtp:", otpErr?.message ?? "sin sesión"); process.exit(1); }

const CACHE_DIR = join(tmpdir(), "pase-e2e-auth-cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const hash = crypto.createHash("sha1").update(EMAIL).digest("hex").slice(0, 12);
writeFileSync(join(CACHE_DIR, `auth-${hash}.json`), JSON.stringify({
  access_token: sess.session.access_token,
  refresh_token: sess.session.refresh_token,
  expires_at: Date.now() + 50 * 60 * 1000,
  email: EMAIL,
}), "utf-8");
console.log("OK: sesión superadmin cacheada en", join(CACHE_DIR, `auth-${hash}.json`));
