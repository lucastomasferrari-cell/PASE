// Helper para generar códigos TOTP RFC 6238 en tests E2E.
// Replica el algoritmo de la RPC `fn_calcular_totp` (migration 202605180000)
// para que los tests puedan generar códigos válidos del lado del cliente.
//
// Uso típico:
//   const code = currentTotpCode(tenantTotpSecret); // ej "123456"
//   await ui.fillManagerOverrideModal(code);

import crypto from "node:crypto";

/**
 * Decodifica un secret base32 a Buffer (RFC 4648).
 * Postgres pgcrypto guarda el secret en base32; replicamos el decode acá
 * para hashear lo mismo.
 */
function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`Char inválido base32: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Calcula el código TOTP actual (RFC 6238) para el secret dado.
 * Time step: 30 segundos (default).
 * Algorithm: HMAC-SHA1 (compatible con Google Authenticator).
 * Dígitos: 6.
 *
 * @param secretBase32 Secret en base32, como lo guarda `tenant_totp_secret.secret_base32`
 * @returns Código de 6 dígitos como string (con leading zeros si es necesario)
 */
export function currentTotpCode(secretBase32: string): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac[offset]! & 0x7f) << 24)
             | ((hmac[offset + 1]! & 0xff) << 16)
             | ((hmac[offset + 2]! & 0xff) << 8)
             | (hmac[offset + 3]! & 0xff);

  return (code % 1_000_000).toString().padStart(6, "0");
}
