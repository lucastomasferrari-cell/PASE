// Helper para generar códigos TOTP RFC 6238 en tests E2E.
// Replica el algoritmo de la RPC `fn_calcular_totp` (migration 202605180000)
// para que los tests puedan generar códigos válidos del lado del cliente.
//
// El secret en `tenant_totp_secret.secret` es BYTEA (20 bytes random). En el
// seed E2E lo guardamos como hex string para facilitar pasarlo en results.
//
// Uso típico:
//   const code = currentTotpCode(seed.totpSecret); // hex
//   await ui.fillManagerOverrideModal(code);

import crypto from "node:crypto";

/**
 * Calcula el código TOTP actual (RFC 6238) para el secret dado.
 * Time step: 30 segundos (default).
 * Algorithm: HMAC-SHA1 (compatible con Google Authenticator).
 * Dígitos: 6.
 *
 * @param secretHex Secret en hex (40 chars = 20 bytes), tal como lo
 *                  expone `seedE2ETenant().totpSecret`.
 * @returns Código de 6 dígitos como string (con leading zeros si es necesario)
 */
export function currentTotpCode(secretHex: string): string {
  const key = Buffer.from(secretHex, "hex");
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
