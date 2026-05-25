// Caché de tokens de autenticación entre tests E2E.
//
// Por qué existe:
// La suite E2E full tiene 85+ tests, cada uno hace signInWithPassword en
// su beforeAll (superadmin + dueño E2E). Eso = ~170 logins en 3 minutos.
// Supabase rate-limita logins agresivamente (~30/min/IP) → los últimos
// tests fallan con "Request rate limit reached".
//
// Solución sin tocar la estructura de los tests: persistir el token de
// auth en disco (/tmp) entre tests. El primero hace login real + guarda;
// los siguientes leen el token cacheado y lo aplican con setSession.
//
// El JWT de Supabase vive 60min por default. Cacheamos por 50min para
// margen de seguridad. Si el cache está vencido (o no existe), el caller
// hace login real + actualiza.
//
// Patrón equivalente a globalSetup de Playwright pero menos invasivo
// (no requiere cambiar imports de los tests).

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

interface CachedAuth {
  access_token: string;
  refresh_token: string;
  expires_at: number;  // unix ms
  email: string;
}

const CACHE_DIR = join(tmpdir(), "pase-e2e-auth-cache");
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min — JWT Supabase es 60 min

function cachePath(email: string): string {
  // Hash del email para evitar caracteres raros en filename.
  const hash = crypto.createHash("sha1").update(email).digest("hex").slice(0, 12);
  return join(CACHE_DIR, `auth-${hash}.json`);
}

/**
 * Lee el token cacheado para un email. Retorna null si:
 * - No existe el cache
 * - Está vencido (más de 50 min desde guardado)
 * - El archivo está corrupto
 */
export function getCachedAuth(email: string): CachedAuth | null {
  try {
    const path = cachePath(email);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CachedAuth;
    if (data.expires_at < Date.now()) return null;
    if (data.email !== email) return null; // hash collision defensive check
    return data;
  } catch {
    return null;
  }
}

/**
 * Guarda el token de auth en cache. Lo llaman los helpers de
 * createSuperadminClient / createE2EDuenoClient después de un login exitoso.
 */
export function setCachedAuth(
  email: string,
  access_token: string,
  refresh_token: string,
): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const data: CachedAuth = {
      access_token,
      refresh_token,
      expires_at: Date.now() + TOKEN_TTL_MS,
      email,
    };
    writeFileSync(cachePath(email), JSON.stringify(data), { encoding: "utf-8" });
  } catch (e) {
    // Si falla guardar (disk full?), no rompemos — solo perdemos el speedup.
    console.warn("[auth-cache] write falló:", e);
  }
}

/**
 * Invalida el cache de un email. Útil después de cleanup del tenant E2E
 * (el auth.user se borra y el token cacheado deja de ser válido).
 */
export function clearCachedAuth(email: string): void {
  try {
    const path = cachePath(email);
    if (existsSync(path)) {
      // Usamos writeFile con "" en lugar de unlink para evitar race conditions.
      writeFileSync(path, "{}", { encoding: "utf-8" });
    }
  } catch {
    // No-op
  }
}
